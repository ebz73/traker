(() => {
  "use strict";

  const CHARACTERS = {
    purple: {
      bg: "#6c3ff5",
      bodyShape: "rect",
      eyeStyle: "eyeball",
      eyeWhite: "#FFFFFF",
      pupilColor: "#252525",
      backdrop: "#efeef5",
      mouthColor: "rgba(255,255,255,0.55)",
    },
    black: {
      bg: "#2d2d2d",
      bodyShape: "rect",
      eyeStyle: "eyeball",
      eyeWhite: "#FFFFFF",
      pupilColor: "#1D1D1D",
      backdrop: "#efeef5",
      mouthColor: "rgba(255,255,255,0.5)",
    },
    orange: {
      bg: "#ff9b6b",
      bodyShape: "dome",
      eyeStyle: "dot",
      pupilColor: "#3A2B24",
      backdrop: "#fff0e8",
      mouthColor: "#3A2B24",
    },
    yellow: {
      bg: "#e8d754",
      bodyShape: "dome",
      eyeStyle: "dot",
      pupilColor: "#3A3420",
      backdrop: "#fdf8e0",
      mouthColor: "#3A3420",
    },
  };

  function px(value) {
    return `${value}px`;
  }

  function clearElement(element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function setStyles(element, styles) {
    Object.entries(styles).forEach(([key, value]) => {
      element.style[key] = value;
    });
  }

  function createDiv(styles) {
    const element = document.createElement("div");
    setStyles(element, styles);
    return element;
  }

  /**
   * Render an animated avatar into a container element.
   * @param {HTMLElement} container - The element to render into (will be emptied first)
   * @param {string} characterName - One of: 'purple', 'black', 'orange', 'yellow'
   * @param {number} size - Avatar diameter in pixels
   * @returns {{ destroy: Function }} - Call destroy() to stop animations and clean up
   */
  function renderAvatar(container, characterName, size) {
    if (!(container instanceof HTMLElement)) {
      return { destroy() {} };
    }

    const priorHandle = container.__trakerAvatarHandle;
    if (priorHandle && typeof priorHandle.destroy === "function") {
      priorHandle.destroy();
    }

    const avatar = CHARACTERS[characterName] || CHARACTERS.purple;
    const bodyWidth = avatar.bodyShape === "rect" ? size * 0.8 : size * 0.92;
    const bodyHeight = avatar.bodyShape === "rect" ? size * 0.74 : size * 0.68;
    const bodyOverhang = size * 0.04;
    const eyeTop = avatar.bodyShape === "rect" ? size * 0.42 : size * 0.44;
    const eyeGap = size * 0.1;
    const eyeballSize = size * 0.22;
    const dotSize = size * 0.12;
    const pupilSize = size * 0.1;
    const mouthWidth = avatar.bodyShape === "rect" ? size * 0.28 : size * 0.26;
    const mouthHeight = size * 0.08;
    const mouthBottom = avatar.bodyShape === "rect" ? size * 0.16 : size * 0.18;
    const smileThickness = Math.max(1.5, size * 0.05);
    const maxDrift = size * 0.04;
    const blinkHeight = 2;
    const eyeSocketSize = Math.max(eyeballSize, dotSize) + maxDrift * 2 + 2;

    clearElement(container);

    const wrap = createDiv({
      width: px(size),
      height: px(size),
      borderRadius: "50%",
      overflow: "hidden",
      position: "relative",
      flexShrink: "0",
    });
    wrap.setAttribute("aria-hidden", "true");

    const body = createDiv({
      width: "100%",
      height: "100%",
      position: "relative",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      background: avatar.backdrop,
    });

    const bodyShape = createDiv({
      position: "absolute",
      bottom: px(-bodyOverhang),
      left: "50%",
      transform: "translateX(-50%)",
      width: px(bodyWidth),
      height: px(bodyHeight),
      background: avatar.bg,
      borderRadius: avatar.bodyShape === "rect" ? "20% 20% 0 0" : "50% 50% 0 0",
    });

    const eyeRow = createDiv({
      position: "absolute",
      top: px(eyeTop),
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: px(eyeGap),
      zIndex: "2",
    });

    const mouth = createDiv({
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%)",
      width: px(mouthWidth),
      height: px(mouthHeight),
      bottom: px(mouthBottom),
      borderBottom: `${px(smileThickness)} solid ${avatar.mouthColor}`,
      borderRadius: "0 0 999px 999px",
      zIndex: "2",
      boxSizing: "border-box",
    });

    const movingElements = [];
    const eyeballElements = [];
    const dotElements = [];

    for (let eyeIndex = 0; eyeIndex < 2; eyeIndex += 1) {
      const eyeSocket = createDiv({
        width: px(eyeSocketSize),
        height: px(eyeSocketSize),
        display: "grid",
        placeItems: "center",
        overflow: "visible",
      });

      if (avatar.eyeStyle === "eyeball") {
        const eyeball = createDiv({
          width: px(eyeballSize),
          height: px(eyeballSize),
          background: avatar.eyeWhite,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "height 120ms ease, border-radius 120ms ease",
          overflow: "hidden",
        });

        const pupil = createDiv({
          width: px(pupilSize),
          height: px(pupilSize),
          background: avatar.pupilColor,
          borderRadius: "50%",
          transform: "translate(0px, 0px)",
          opacity: "1",
          transition: "transform 160ms ease-out, opacity 80ms ease",
          willChange: "transform",
        });

        eyeball.appendChild(pupil);
        eyeSocket.appendChild(eyeball);
        movingElements.push(pupil);
        eyeballElements.push({ eyeball, pupil });
      } else {
        const dotEye = createDiv({
          width: px(dotSize),
          height: px(dotSize),
          background: avatar.pupilColor,
          borderRadius: "50%",
          transform: "translate(0px, 0px)",
          transition: "height 120ms ease, border-radius 120ms ease, transform 160ms ease-out",
          willChange: "transform",
        });

        eyeSocket.appendChild(dotEye);
        movingElements.push(dotEye);
        dotElements.push(dotEye);
      }

      eyeRow.appendChild(eyeSocket);
    }

    body.appendChild(bodyShape);
    body.appendChild(eyeRow);
    body.appendChild(mouth);
    wrap.appendChild(body);
    container.appendChild(wrap);

    let animationFrameId = 0;
    let blinkTimerId = 0;
    let reopenTimerId = 0;
    let destroyed = false;
    let offsetX = 0;
    let offsetY = 0;
    const startTime = performance.now();

    function applyBlinkState(isBlinking) {
      eyeballElements.forEach(({ eyeball, pupil }) => {
        eyeball.style.height = isBlinking ? px(blinkHeight) : px(eyeballSize);
        eyeball.style.borderRadius = isBlinking ? "2px" : "50%";
        pupil.style.opacity = isBlinking ? "0" : "1";
      });

      dotElements.forEach((dotEye) => {
        dotEye.style.height = isBlinking ? px(blinkHeight) : px(dotSize);
        dotEye.style.borderRadius = isBlinking ? "1px" : "50%";
      });
    }

    function animate(timestamp) {
      if (destroyed) return;

      const t = (timestamp - startTime) / 1000;
      const nextOffsetX = Math.sin(t * 0.6) * maxDrift;
      const nextOffsetY = Math.sin(t * 0.4) * maxDrift * 0.6;

      if (Math.abs(nextOffsetX - offsetX) >= 0.01 || Math.abs(nextOffsetY - offsetY) >= 0.01) {
        offsetX = nextOffsetX;
        offsetY = nextOffsetY;
        const transform = `translate(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px)`;
        movingElements.forEach((element) => {
          element.style.transform = transform;
        });
      }

      animationFrameId = window.requestAnimationFrame(animate);
    }

    function scheduleNextBlink() {
      if (destroyed) return;

      const nextDelay = 2500 + Math.random() * 3500;
      blinkTimerId = window.setTimeout(() => {
        if (destroyed) return;

        applyBlinkState(true);
        reopenTimerId = window.setTimeout(() => {
          if (destroyed) return;

          applyBlinkState(false);
          scheduleNextBlink();
        }, 150);
      }, nextDelay);
    }

    applyBlinkState(false);
    animationFrameId = window.requestAnimationFrame(animate);
    scheduleNextBlink();

    const handle = {
      destroy() {
        if (destroyed) return;

        destroyed = true;
        if (animationFrameId) {
          window.cancelAnimationFrame(animationFrameId);
        }
        window.clearTimeout(blinkTimerId);
        window.clearTimeout(reopenTimerId);
        if (container.__trakerAvatarHandle === handle) {
          delete container.__trakerAvatarHandle;
        }
        clearElement(container);
      },
    };

    container.__trakerAvatarHandle = handle;
    return handle;
  }

  window.renderAvatar = renderAvatar;
})();
