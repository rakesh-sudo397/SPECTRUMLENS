import cv2
import numpy as np
import math
import time
from typing import List, Dict, Tuple, Optional

class OpticalLensDetector:
    """
    Deterministic Computer Vision Engine for Hidden Camera Lens Detection.
    
    Uses physical optical retroreflection properties:
    1. Specular highlight thresholding & dynamic contrast isolation.
    2. Geometric circularity and aspect ratio filtering (Isoperimetric Quotient).
    3. Multi-directional radial gradient analysis (Airy-Disk symmetry vs. flat metallic scatter).
    4. Near-Infrared (NIR) 850nm chromaticity signature detection.
    5. Temporal consistency tracking to reject single-frame noise.
    """

    def __init__(self, sensitivity: str = "normal"):
        self.set_sensitivity(sensitivity)
        self.tracker_history: Dict[int, Dict] = {}
        self.next_track_id = 0
        self.max_disappeared = 6
        self.disappeared: Dict[int, int] = {}
        self.last_frame_gray: Optional[np.ndarray] = None

    def set_sensitivity(self, level: str):
        level = level.lower()
        if level == "high":
            self.min_intensity = 225
            self.min_circularity = 0.70
            self.min_area = 5
            self.max_area = 3000
            self.radial_symmetry_threshold = 0.38
            self.min_gradient_drop = 25.0
            self.confirmation_frames = 1
        elif level == "ultra":
            self.min_intensity = 210
            self.min_circularity = 0.65
            self.min_area = 4
            self.max_area = 4500
            self.radial_symmetry_threshold = 0.35
            self.min_gradient_drop = 20.0
            self.confirmation_frames = 1
        else:  # normal / balanced (optimized against screen glare)
            self.min_intensity = 232
            self.min_circularity = 0.74
            self.min_area = 6
            self.max_area = 2500
            self.radial_symmetry_threshold = 0.45
            self.min_gradient_drop = 35.0
            self.confirmation_frames = 2

    def compute_radial_symmetry(self, gray: np.ndarray, cx: int, cy: int, radius: int) -> float:
        """
        Computes the radial intensity gradient symmetry around the candidate centroid.
        Curved optical lenses produce isotropic radial decay (Airy pattern), whereas
        screws and flat metallic surfaces scatter light anisotropically (irregular directions).
        
        Returns a score between 0.0 (asymmetric/irregular) and 1.0 (highly symmetric lens).
        """
        h, w = gray.shape
        r = max(4, min(radius, 22))
        
        center_val = float(gray[cy, cx])
        # A true optical flash retroreflection saturates the sensor core
        if center_val < 235:
            return 0.0  # Screen icons / flat graphics lack hyper-concentrated specular core

        # Sample intensity profiles along 8 radial spokes
        angles = [0, 45, 90, 135, 180, 225, 270, 315]
        spoke_falloffs = []

        for ang in angles:
            rad = math.radians(ang)
            dx = int(round(r * math.cos(rad)))
            dy = int(round(r * math.sin(rad)))
            nx, ny = cx + dx, cy + dy
            
            if 0 <= nx < w and 0 <= ny < h:
                edge_val = float(gray[ny, nx])
                drop = max(0.0, center_val - edge_val)
                spoke_falloffs.append(drop)
            else:
                spoke_falloffs.append(0.0)

        mean_drop = np.mean(spoke_falloffs)
        # Must have steep gradient falloff (flat screen icons have almost 0 drop across radius)
        if not spoke_falloffs or mean_drop < self.min_gradient_drop:
            return 0.0

        mean_drop = np.mean(spoke_falloffs)
        std_drop = np.std(spoke_falloffs)
        
        # Coefficient of variation (CV = std / mean)
        cv = std_drop / (mean_drop + 1e-5)
        
        # Symmetric lens -> low variance across radial spokes -> high symmetry score
        symmetry_score = max(0.0, min(1.0, 1.0 - cv))
        return float(symmetry_score)

    def check_nir_signature(self, bgr: np.ndarray, cx: int, cy: int, radius: int) -> Tuple[bool, float]:
        """
        Checks for Near-Infrared (NIR) 850nm/940nm optical reflection.
        On CMOS sensors with weak IR-cut filters, active IR LEDs or illuminated lenses
        appear with distinct violet/magenta saturation (high Red + high Blue with suppressed Green).
        """
        h, w, _ = bgr.shape
        x1, x2 = max(0, cx - radius), min(w, cx + radius + 1)
        y1, y2 = max(0, cy - radius), min(h, cy + radius + 1)
        
        roi = bgr[y1:y2, x1:x2]
        if roi.size == 0:
            return False, 0.0

        b_mean = float(np.mean(roi[:, :, 0]))
        g_mean = float(np.mean(roi[:, :, 1]))
        r_mean = float(np.mean(roi[:, :, 2]))

        # High red + blue with lower green indicates near-infrared chromatic leak
        if (r_mean > 140 and b_mean > 130 and g_mean < (r_mean + b_mean) * 0.42):
            nir_confidence = min(1.0, (r_mean + b_mean) / 510.0)
            return True, nir_confidence
        return False, 0.0

    def process_frame(self, frame_bgr: np.ndarray, is_differential: bool = False, baseline_gray: Optional[np.ndarray] = None, single_frame: bool = False) -> List[Dict]:
        """
        Main processing method for a single video frame.
        Returns a list of detected candidate lenses with bounding boxes and confidence metrics.
        """
        h, w = frame_bgr.shape[:2]
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        
        # Stage 1: Ambient Compensation / Differencing
        if is_differential and baseline_gray is not None and baseline_gray.shape == gray.shape:
            # Differential Flash Subtraction: Delta = |Flash_On - Flash_Off|
            diff = cv2.absdiff(gray, baseline_gray)
            processed_gray = cv2.addWeighted(diff, 1.5, gray, 0.2, 0)
        else:
            # Dynamic Local Contrast Enhancement
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            processed_gray = clahe.apply(gray)

        # Stage 2: Specular Peak Isolation
        # Extract the highest luminance regions
        _, thresh = cv2.threshold(processed_gray, self.min_intensity, 255, cv2.THRESH_BINARY)
        
        # Morphological clean up to separate touching glares
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)

        # Stage 3: Contour & Geometric Filtering
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        candidates = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self.min_area or area > self.max_area:
                continue

            perimeter = cv2.arcLength(cnt, True)
            if perimeter == 0:
                continue

            # Circularity metric (Isoperimetric quotient)
            circularity = 4 * math.pi * (area / (perimeter * perimeter))
            if circularity < self.min_circularity:
                continue

            x, y, bw, bh = cv2.boundingRect(cnt)
            aspect_ratio = float(bw) / float(bh)
            if not (0.70 <= aspect_ratio <= 1.42):
                # Screws and linear scratches are oblong
                continue

            # Centroid computation
            M = cv2.moments(cnt)
            if M["m00"] == 0:
                continue
            cx = int(M["m10"] / M["m00"])
            cy = int(M["m01"] / M["m00"])
            radius = int(max(bw, bh) / 2)

            # Stage 4: Radial Airy Symmetry Analysis
            symmetry_score = self.compute_radial_symmetry(gray, cx, cy, radius)
            if symmetry_score < self.radial_symmetry_threshold:
                # Irregular metallic surface / screw thread
                continue

            # Stage 5: Check NIR night-vision signature
            is_nir, nir_conf = self.check_nir_signature(frame_bgr, cx, cy, radius)

            # Combined Confidence Score calculation (weighted for pinhole optics)
            area_weight = min(1.0, area / 40.0) * 0.05
            base_conf = (circularity * 0.50) + (symmetry_score * 0.50) + area_weight
            if is_nir:
                base_conf = min(0.99, base_conf + 0.15)

            confidence = round(float(np.clip(base_conf, 0.45, 0.98)), 2)

            candidates.append({
                "x": int(x),
                "y": int(y),
                "w": int(bw),
                "h": int(bh),
                "cx": int(cx),
                "cy": int(cy),
                "area": float(area),
                "circularity": round(circularity, 2),
                "symmetry": round(symmetry_score, 2),
                "is_nir": bool(is_nir),
                "confidence": confidence,
                "label": "Optical Aperture" if not is_nir else "NIR Lens Emitter"
            })

        # Stage 6: Temporal Tracking & Confirmation
        confirmed_detections = self._update_temporal_tracker(candidates, single_frame=single_frame)
        self.last_frame_gray = gray
        return confirmed_detections

    def _update_temporal_tracker(self, candidates: List[Dict], single_frame: bool = False) -> List[Dict]:
        """
        Updates temporal state to ensure detected lens persists across frames,
        eliminating momentary hand-jitter and camera noise.
        """
        current_time = time.time()
        confirmed = []

        if not candidates:
            # Age existing tracks
            for track_id in list(self.disappeared.keys()):
                self.disappeared[track_id] += 1
                if self.disappeared[track_id] > self.max_disappeared:
                    del self.disappeared[track_id]
                    if track_id in self.tracker_history:
                        del self.tracker_history[track_id]
            return []

        # Match candidates with existing tracks using Euclidean distance
        if not self.tracker_history:
            for cand in candidates:
                self.tracker_history[self.next_track_id] = {
                    "cx": cand["cx"],
                    "cy": cand["cy"],
                    "hits": 1,
                    "last_seen": current_time,
                    "data": cand
                }
                self.disappeared[self.next_track_id] = 0
                if cand["confidence"] >= 0.82 or self.confirmation_frames <= 1 or single_frame:
                    cand["track_id"] = self.next_track_id
                    confirmed.append(cand)
                self.next_track_id += 1
            return confirmed

        track_ids = list(self.tracker_history.keys())
        prev_centers = np.array([[self.tracker_history[tid]["cx"], self.tracker_history[tid]["cy"]] for tid in track_ids])
        current_centers = np.array([[cand["cx"], cand["cy"]] for cand in candidates])

        # Compute pairwise distance matrix
        dists = np.linalg.norm(prev_centers[:, np.newaxis] - current_centers, axis=2)

        matched_tracks = set()
        matched_cands = set()

        # Greedy match closest centroids
        for _ in range(min(len(track_ids), len(candidates))):
            min_idx = np.unravel_index(np.argmin(dists), dists.shape)
            tid_idx, cand_idx = min_idx[0], min_idx[1]
            dist_val = dists[tid_idx, cand_idx]

            if dist_val > 50.0:  # Max allowable shift between consecutive frames
                break

            tid = track_ids[tid_idx]
            cand = candidates[cand_idx]

            self.tracker_history[tid]["cx"] = cand["cx"]
            self.tracker_history[tid]["cy"] = cand["cy"]
            self.tracker_history[tid]["hits"] += 1
            self.tracker_history[tid]["last_seen"] = current_time
            self.tracker_history[tid]["data"] = cand
            self.disappeared[tid] = 0

            matched_tracks.add(tid)
            matched_cands.add(cand_idx)

            dists[tid_idx, :] = np.inf
            dists[:, cand_idx] = np.inf

            # Confirm if tracked for threshold frames or strong optical signature
            if self.tracker_history[tid]["hits"] >= self.confirmation_frames or cand["confidence"] >= 0.82 or single_frame:
                cand["track_id"] = tid
                cand["hits"] = self.tracker_history[tid]["hits"]
                confirmed.append(cand)

        # Add remaining candidates as new tracks
        for idx, cand in enumerate(candidates):
            if idx not in matched_cands:
                self.tracker_history[self.next_track_id] = {
                    "cx": cand["cx"],
                    "cy": cand["cy"],
                    "hits": 1,
                    "last_seen": current_time,
                    "data": cand
                }
                self.disappeared[self.next_track_id] = 0
                if cand["confidence"] >= 0.82 or self.confirmation_frames <= 1 or single_frame:
                    cand["track_id"] = self.next_track_id
                    confirmed.append(cand)
                self.next_track_id += 1

        # Age unmatched tracks
        for tid in track_ids:
            if tid not in matched_tracks:
                self.disappeared[tid] += 1
                if self.disappeared[tid] > self.max_disappeared:
                    del self.disappeared[tid]
                    if tid in self.tracker_history:
                        del self.tracker_history[tid]

        return confirmed
