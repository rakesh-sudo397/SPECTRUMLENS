document.addEventListener('DOMContentLoaded', () => {
  const videoElem = document.getElementById('cameraFeed');
  const canvasElem = document.getElementById('overlayCanvas');
  const ctx = canvasElem.getContext('2d');

  const threatBadge = document.getElementById('threatBadge');
  const fpsBadge = document.getElementById('fpsBadge');
  const alertBanner = document.getElementById('alertBanner');
  const alertText = document.getElementById('alertText');

  const btnTorch = document.getElementById('btnTorch');
  const btnAudio = document.getElementById('btnAudio');
  const btnSensitivity = document.getElementById('btnSensitivity');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.panel');

  const cameraCtrl = new CameraController(videoElem);
  let ws = null;
  let isScanning = false;
  let scanInterval = null;
  let currentThreat = 'CLEAN';
  let sensitivityLevels = ['normal', 'high', 'ultra'];
  let currentSensIdx = 0;
  let sessionDetections = [];
  let scanStartTime = Date.now();
  let latestNetworkData = null;

  // Initialize UI & Audio
  document.body.addEventListener('click', () => {
    window.tacticalAudio.init();
  }, { once: true });

  // 1. Tab Switching
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      window.tacticalAudio.playConfirm();

      if (targetId === 'scannerPanel') {
        startScannerLoop();
      } else {
        stopScannerLoop();
      }
    });
  });

  // 2. Camera & WebSocket Initialization
  async function initCameraAndSocket() {
    const res = await cameraCtrl.startCamera();
    if (!res.success) {
      alert("Camera access denied or unavailable: " + res.error);
      return;
    }

    if (cameraCtrl.hasTorch) {
      btnTorch.style.display = 'flex';
    } else {
      btnTorch.title = "Simulated Flash (Hardware Torch not supported on this browser)";
    }

    connectWebSocket();
    startScannerLoop();
  }

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/stream`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[SpecterLens] WebSocket Connected");
      fpsBadge.textContent = "LINK: ONLINE";
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleDetectionResults(data);
      } catch (e) {
        console.error("WS Parse error:", e);
      }
    };

    ws.onclose = () => {
      fpsBadge.textContent = "LINK: RECONNECTING";
      setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function startScannerLoop() {
    if (isScanning) return;
    isScanning = true;

    // Send frames at ~16 FPS
    scanInterval = setInterval(() => {
      if (!isScanning || !ws || ws.readyState !== WebSocket.OPEN) return;

      const frameBase64 = cameraCtrl.captureFrame(480);
      if (frameBase64) {
        ws.send(JSON.stringify({
          frame: frameBase64,
          is_differential: false
        }));
      }
    }, 70);
  }

  function stopScannerLoop() {
    isScanning = false;
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    clearOverlay();
  }

  // 3. Render Tactical HUD & Detections
  function handleDetectionResults(data) {
    fpsBadge.textContent = `${data.latency_ms} MS`;

    // Filter out low-confidence screen artifacts (< 0.76)
    const rawDetections = data.detections || [];
    const detections = rawDetections.filter(d => d.confidence >= 0.76);
    currentThreat = detections.length > 0 ? (detections.some(d => d.confidence >= 0.82) ? 'CRITICAL' : 'SUSPICIOUS') : 'CLEAN';

    updateThreatStatus(currentThreat, detections.length);

    // Resize canvas overlay to match video rendering size
    if (canvasElem.width !== videoElem.clientWidth || canvasElem.height !== videoElem.clientHeight) {
      canvasElem.width = videoElem.clientWidth;
      canvasElem.height = videoElem.clientHeight;
    }

    clearOverlay();

    if (detections.length === 0) {
      alertBanner.classList.remove('active');
      return;
    }

    // Scale from frame coordinates (480x...) to canvas viewport
    const scaleX = canvasElem.width / data.width;
    const scaleY = canvasElem.height / data.height;

    detections.forEach(det => {
      sessionDetections.push({
        timestamp: new Date().toLocaleTimeString(),
        label: det.label,
        confidence: det.confidence,
        x: det.cx,
        y: det.cy
      });

      const x = det.x * scaleX;
      const y = det.y * scaleY;
      const w = det.w * scaleX;
      const h = det.h * scaleY;
      const cx = det.cx * scaleX;
      const cy = det.cy * scaleY;

      drawTacticalTarget(x, y, w, h, cx, cy, det);
    });

    // Alert Banner & Audio Siren (Only sound for confirmed targets >= 0.82)
    const highest = detections.reduce((prev, curr) => (prev.confidence > curr.confidence) ? prev : curr, detections[0]);
    if (highest.confidence >= 0.82) {
      alertText.textContent = `TARGET: ${highest.label.toUpperCase()} (${Math.round(highest.confidence * 100)}% CONFIDENCE)`;
      alertBanner.classList.add('active');
      window.tacticalAudio.playAlert();
    } else {
      alertBanner.classList.remove('active');
    }
  }

  function clearOverlay() {
    ctx.clearRect(0, 0, canvasElem.width, canvasElem.height);
  }

  function drawTacticalTarget(x, y, w, h, cx, cy, det) {
    const isCritical = det.confidence >= 0.85;
    const color = isCritical ? '#ff1e44' : '#ffaa00';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;

    // Outer corner brackets
    const bracketLen = Math.min(w, h) * 0.35 + 4;
    // Top-Left
    ctx.beginPath();
    ctx.moveTo(x, y + bracketLen); ctx.lineTo(x, y); ctx.lineTo(x + bracketLen, y);
    ctx.stroke();
    // Top-Right
    ctx.beginPath();
    ctx.moveTo(x + w - bracketLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + bracketLen);
    ctx.stroke();
    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(x, y + h - bracketLen); ctx.lineTo(x, y + h); ctx.lineTo(x + bracketLen, y + h);
    ctx.stroke();
    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(x + w - bracketLen, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - bracketLen);
    ctx.stroke();

    // Center Crosshair
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
    ctx.stroke();

    // Label tag
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = color;
    const label = `TARGET: ${det.label} [${Math.round(det.confidence * 100)}%]`;
    ctx.fillText(label, x, y - 8);

    ctx.restore();
  }

  function updateThreatStatus(threat, count) {
    if (threat === 'CRITICAL') {
      threatBadge.className = 'badge badge-alert';
      threatBadge.textContent = `ALERT: ${count} DETECTED`;
    } else if (threat === 'SUSPICIOUS') {
      threatBadge.className = 'badge';
      threatBadge.style.background = 'rgba(255, 170, 0, 0.2)';
      threatBadge.style.color = '#ffaa00';
      threatBadge.style.border = '1px solid #ffaa00';
      threatBadge.textContent = 'SUSPICIOUS GLINT';
    } else {
      threatBadge.className = 'badge badge-clean';
      threatBadge.textContent = 'SECURE: CLEAN';
    }
  }

  // 4. Torch / Flashlight Toggle
  btnTorch.addEventListener('click', async () => {
    const res = await cameraCtrl.toggleTorch();
    if (res.active) {
      btnTorch.classList.add('active');
      btnTorch.querySelector('span').textContent = "TORCH: ON";
    } else {
      btnTorch.classList.remove('active');
      btnTorch.querySelector('span').textContent = "TORCH: OFF";
    }
    window.tacticalAudio.playConfirm();
  });

  // 5. Audio Toggle
  btnAudio.addEventListener('click', () => {
    const isMuted = window.tacticalAudio.toggleMute();
    if (isMuted) {
      btnAudio.classList.remove('active');
      btnAudio.querySelector('span').textContent = "AUDIO: OFF";
    } else {
      btnAudio.classList.add('active');
      btnAudio.querySelector('span').textContent = "AUDIO: ON";
    }
  });

  // 6. Sensitivity Selector
  btnSensitivity.addEventListener('click', async () => {
    currentSensIdx = (currentSensIdx + 1) % sensitivityLevels.length;
    const newLevel = sensitivityLevels[currentSensIdx];
    btnSensitivity.querySelector('span').textContent = `SENS: ${newLevel.toUpperCase()}`;

    try {
      await fetch('/api/sensitivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: newLevel })
      });
      window.tacticalAudio.playConfirm();
    } catch (e) {
      console.warn("Failed to update sensitivity:", e);
    }
  });

  // 7. Network Sniffer Tab
  const btnRunNetworkScan = document.getElementById('btnRunNetworkScan');
  const networkDeviceList = document.getElementById('networkDeviceList');
  const networkStatusText = document.getElementById('networkStatusText');

  btnRunNetworkScan.addEventListener('click', async () => {
    networkStatusText.textContent = "TRANSMITTING SSDP/UPnP M-SEARCH MULTICAST...";
    btnRunNetworkScan.disabled = true;

    try {
      const resp = await fetch('/api/scan_network');
      const data = await resp.json();
      latestNetworkData = data;
      renderNetworkResults(data);
      window.tacticalAudio.playConfirm();
    } catch (err) {
      networkStatusText.textContent = "Network scan error: " + err.message;
    } finally {
      btnRunNetworkScan.disabled = false;
    }
  });

  function renderNetworkResults(data) {
    networkStatusText.textContent = `Status: ${data.overall_network_risk} (${data.devices_discovered} devices inspected)`;
    networkDeviceList.innerHTML = '';

    data.devices.forEach(dev => {
      const row = document.createElement('div');
      row.className = 'device-row';

      const isCam = dev.is_camera;
      const badgeClass = isCam ? 'badge badge-alert' : 'badge badge-clean';
      const badgeText = isCam ? 'SUSPICIOUS CAM' : 'SAFE ENDPOINT';

      row.innerHTML = `
        <div>
          <div class="device-ip">${dev.ip}</div>
          <div class="device-desc">${dev.server} | ${dev.protocol}</div>
        </div>
        <div class="${badgeClass}">${badgeText}</div>
      `;
      networkDeviceList.appendChild(row);
    });
  }

  // 8. Calibration Playground (Testing Real Reference Images)
  const testCards = document.querySelectorAll('.test-card');
  const testResultsBox = document.getElementById('testResultsBox');

  testCards.forEach(card => {
    card.addEventListener('click', async () => {
      const sampleType = card.getAttribute('data-sample');
      testResultsBox.innerHTML = `<em>Processing ${sampleType.toUpperCase()} through deterministic optical pipeline...</em>`;
      testResultsBox.style.display = 'block';

      try {
        const imgUrl = `/assets/${sampleType === 'lens' ? 'sample_lens.jpg' : 'sample_screw.jpg'}`;
        const imgBlob = await fetch(imgUrl).then(r => r.blob());
        const reader = new FileReader();

        reader.onloadend = async () => {
          const resp = await fetch('/api/detect_frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: reader.result })
          });
          const result = await resp.json();
          renderTestResult(sampleType, result);
        };
        reader.readAsDataURL(imgBlob);
      } catch (e) {
        testResultsBox.innerHTML = `Error running test: ${e.message}`;
      }
    });
  });

  function renderTestResult(type, res) {
    if (type === 'lens') {
      if (res.count > 0) {
        const d = res.detections[0];
        testResultsBox.innerHTML = `
          <div style="color: var(--cyan); font-weight: bold; margin-bottom: 6px;">[RESULT] OPTICAL LENS DETECTED</div>
          <div>• Confidence: <strong>${Math.round(d.confidence * 100)}%</strong></div>
          <div>• Circularity Metric: <strong>${d.circularity}</strong> (Threshold: >0.70)</div>
          <div>• Radial Symmetry: <strong>${d.symmetry}</strong> (Isotropic Airy Decay)</div>
          <div>• Latency: <strong>${res.latency_ms} ms</strong></div>
          <div style="color: var(--green); margin-top: 6px;">=> PASS: Conforms to physical optical aperture profile!</div>
        `;
        window.tacticalAudio.playAlert();
      } else {
        testResultsBox.innerHTML = `<span style="color: var(--amber)">No detection triggered.</span>`;
      }
    } else {
      if (res.count === 0) {
        testResultsBox.innerHTML = `
          <div style="color: var(--green); font-weight: bold; margin-bottom: 6px;">[RESULT] SCREW REJECTED (ZERO FALSE POSITIVE)</div>
          <div>• Detections: <strong>0 Found</strong></div>
          <div>• Reason: Rejected due to asymmetric specular scatter & cross-slot boundary</div>
          <div>• Latency: <strong>${res.latency_ms} ms</strong></div>
          <div style="color: var(--green); margin-top: 6px;">=> PASS: Successfully prevented false alarm on metallic hardware!</div>
        `;
        window.tacticalAudio.playConfirm();
      } else {
        testResultsBox.innerHTML = `<div style="color: var(--red)">False Positive Triggered on Screw.</div>`;
      }
    }
  }

  // 9. Generate Audit Certificate
  const btnGenerateReport = document.getElementById('btnGenerateReport');
  const certContainer = document.getElementById('certContainer');

  btnGenerateReport.addEventListener('click', async () => {
    const roomName = document.getElementById('reportRoomName').value || "Executive Suite / Room 402";
    const inspectorName = document.getElementById('reportInspectorName').value || "Security Auditor";
    const duration = Math.round((Date.now() - scanStartTime) / 1000);

    try {
      const resp = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_name: roomName,
          inspector_name: inspectorName,
          scan_duration_sec: duration,
          detections: sessionDetections,
          network_summary: latestNetworkData
        })
      });
      const cert = await resp.json();
      renderCertificate(cert);
      window.tacticalAudio.playConfirm();
    } catch (e) {
      alert("Error generating report: " + e.message);
    }
  });

  function renderCertificate(cert) {
    const isClean = cert.optical_anomalies_found === 0;
    const sealClass = isClean ? 'cert-seal' : 'cert-seal badge-alert';

    certContainer.innerHTML = `
      <div class="certificate-box">
        <div class="cert-header">
          <div style="font-size: 1.1rem; color: var(--cyan); letter-spacing: 2px;">ROOM PRIVACY AUDIT CERTIFICATE</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">CERT ID: ${cert.certificate_id}</div>
          <div class="${sealClass}">${cert.final_verdict}</div>
        </div>
        <div class="cert-row"><span>Target Space:</span> <strong>${cert.room_name}</strong></div>
        <div class="cert-row"><span>Inspector:</span> <strong>${cert.inspector}</strong></div>
        <div class="cert-row"><span>Audit Timestamp:</span> <strong>${cert.timestamp}</strong></div>
        <div class="cert-row"><span>Scan Duration:</span> <strong>${cert.duration_seconds}s</strong></div>
        <div class="cert-row"><span>Optical Glints Found:</span> <strong>${cert.optical_anomalies_found}</strong></div>
        <div class="cert-row"><span>Network Streaming Cams:</span> <strong>${cert.network_audit ? cert.network_audit.cameras_detected : 0}</strong></div>
        <div style="margin-top: 14px; text-align: center;">
          <button class="btn-tactical" onclick="window.print()" style="margin: 0 auto;">PRINT / SAVE PDF</button>
        </div>
      </div>
    `;
    certContainer.style.display = 'block';
  }

  // Boot Camera
  initCameraAndSocket();
});
