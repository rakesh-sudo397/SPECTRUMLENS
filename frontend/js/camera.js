class CameraController {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.track = null;
    this.hasTorch = false;
    this.torchActive = false;
    this.captureCanvas = document.createElement('canvas');
    this.captureCtx = this.captureCanvas.getContext('2d');
    this.isStreaming = false;
  }

  async startCamera() {
    try {
      const constraints = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      this.track = this.stream.getVideoTracks()[0];
      if (this.track && typeof this.track.getCapabilities === 'function') {
        const capabilities = this.track.getCapabilities();
        this.hasTorch = !!capabilities.torch;
      }

      this.isStreaming = true;
      return { success: true, hasTorch: this.hasTorch };
    } catch (err) {
      console.warn("Camera start failed, falling back to desktop/default constraints:", err);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.video.srcObject = this.stream;
        await this.video.play();
        this.track = this.stream.getVideoTracks()[0];
        this.isStreaming = true;
        return { success: true, hasTorch: false };
      } catch (fallbackErr) {
        return { success: false, error: fallbackErr.message };
      }
    }
  }

  async toggleTorch(forceState = null) {
    if (!this.track || !this.hasTorch) {
      // Fallback: visual indication
      this.torchActive = forceState !== null ? forceState : !this.torchActive;
      return { active: this.torchActive, simulated: true };
    }

    try {
      this.torchActive = forceState !== null ? forceState : !this.torchActive;
      await this.track.applyConstraints({
        advanced: [{ torch: this.torchActive }]
      });
      return { active: this.torchActive, simulated: false };
    } catch (e) {
      console.warn("Torch constraint error:", e);
      return { active: false, error: e.message };
    }
  }

  captureFrame(targetWidth = 480) {
    if (!this.isStreaming || this.video.videoWidth === 0) return null;

    const aspect = this.video.videoHeight / this.video.videoWidth;
    const targetHeight = Math.round(targetWidth * aspect);

    this.captureCanvas.width = targetWidth;
    this.captureCanvas.height = targetHeight;

    this.captureCtx.drawImage(this.video, 0, 0, targetWidth, targetHeight);
    return this.captureCanvas.toDataURL('image/jpeg', 0.62);
  }

  stopCamera() {
    if (this.stream) {
      if (this.hasTorch && this.torchActive) {
        this.toggleTorch(false);
      }
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.track = null;
      this.isStreaming = false;
    }
  }
}

window.CameraController = CameraController;
