const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId") || "";
const rawUrl = params.get("url") || "";
const domain = params.get("domain") || "";

const elTitle = document.getElementById("title");
const elSummary = document.getElementById("summary");
const elDetail = document.getElementById("detail");
const elActions = document.getElementById("actions");
const elInvalidActions = document.getElementById("invalid-actions");
const elAllow = document.getElementById("allow-btn");
const elCancel = document.getElementById("cancel-btn");
const elClose = document.getElementById("close-btn");
const elScene = document.querySelector(".scene");

const SCALE = 0.80;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const randomInRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function resolveLook({ deltaX, deltaY, maxDistance, forceLookX, forceLookY }) {
  if (typeof forceLookX === "number" || typeof forceLookY === "number") {
    return {
      x: clamp(typeof forceLookX === "number" ? forceLookX : 0, -maxDistance, maxDistance),
      y: clamp(typeof forceLookY === "number" ? forceLookY : 0, -maxDistance, maxDistance),
    };
  }

  const angle = Math.atan2(deltaY, deltaX);
  const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), maxDistance);

  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
  };
}

function scaleValue(value) {
  return value * SCALE;
}

const CHARACTERS = {
  purple: {
    element: document.getElementById("char-purple"),
    eyeRowClass: "lp-eyeRow lp-eyeRowPurple",
    eyeStyle: "eyeball",
    eyeSize: 18,
    pupilSize: 7,
    maxDistance: 5,
    eyeColor: "#FFFFFF",
    pupilColor: "#252525",
    blinkMin: 3000,
    blinkMax: 7000,
    track: { deltaX: 80, deltaY: 60, skew: -0.5 },
    eyeLeftDivisor: 20,
    eyeLeftClamp: 15,
    eyeTopBase: 110,
    eyeTopDivisor: 30,
    eyeTopClamp: 10,
    grantedSkew: 3,
    grantedLook: { x: 0, y: 0 },
    mouth: null,
  },
  black: {
    element: document.getElementById("char-black"),
    eyeRowClass: "lp-eyeRow lp-eyeRowBlack",
    eyeStyle: "eyeball",
    eyeSize: 16,
    pupilSize: 6,
    maxDistance: 4,
    eyeColor: "#FFFFFF",
    pupilColor: "#1D1D1D",
    blinkMin: 3400,
    blinkMax: 7400,
    track: { deltaX: -40, deltaY: 50, skew: 0.3 },
    eyeLeftDivisor: 20,
    eyeLeftClamp: 12,
    eyeTopBase: 88,
    eyeTopDivisor: 30,
    eyeTopClamp: 8,
    grantedSkew: -3,
    grantedLook: { x: 0, y: 0 },
    mouth: null,
  },
  orange: {
    element: document.getElementById("char-orange"),
    eyeRowClass: "lp-eyeRow lp-eyeRowOrange",
    eyeStyle: "pupil",
    pupilSize: 12,
    socketSize: 24,
    maxDistance: 4,
    pupilColor: "#3A2B24",
    blinkMin: 3600,
    blinkMax: 7600,
    track: { deltaX: 60, deltaY: 40, skew: -0.3 },
    eyeLeftDivisor: 18,
    eyeLeftClamp: 14,
    eyeTopBase: 100,
    eyeTopDivisor: 25,
    eyeTopClamp: 8,
    grantedSkew: 0,
    grantedLook: { x: 0, y: 0 },
    mouth: {
      className: "lp-mouth lp-mouthOrange",
      smile: true,
      xDivisor: 180,
      xClamp: 4,
      yDivisor: 220,
      yClamp: 2,
    },
  },
  yellow: {
    element: document.getElementById("char-yellow"),
    eyeRowClass: "lp-eyeRow lp-eyeRowYellow",
    eyeStyle: "pupil",
    pupilSize: 12,
    socketSize: 24,
    maxDistance: 3.6,
    pupilColor: "#3A3420",
    blinkMin: 3900,
    blinkMax: 7900,
    track: { deltaX: -60, deltaY: 50, skew: 0.4 },
    eyeLeftDivisor: 18,
    eyeLeftClamp: 12,
    eyeTopBase: 85,
    eyeTopDivisor: 25,
    eyeTopClamp: 6,
    grantedSkew: 0,
    grantedLook: { x: 0, y: 0 },
    mouth: {
      className: "lp-mouth lp-mouthYellow",
      smile: true,
      xDivisor: 120,
      xClamp: 8,
      yDivisor: 160,
      yClamp: 4,
    },
  },
};

let permissionOrigin = "";
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let allowHovered = false;
let grantedState = false;
let animationFrameId = 0;
let disposed = false;

const characterStates = [];
const cleanupCallbacks = [];

function setPendingState(isPending) {
  elAllow.disabled = isPending;
  elCancel.disabled = isPending;
  elAllow.textContent = isPending ? "Requesting Access..." : "Allow & Continue";
}

function getCharacterTrack(element, currentMouseX, currentMouseY) {
  if (!element) {
    return { deltaX: 0, deltaY: 0, skew: 0 };
  }

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 3;
  const deltaX = currentMouseX - centerX;
  const deltaY = currentMouseY - centerY;
  const skew = clamp(-deltaX / 120, -6, 6);

  return { deltaX, deltaY, skew };
}

function buildEyeBall(config) {
  const eyeball = document.createElement("div");
  eyeball.className = "lp-eyeball";
  eyeball.style.width = `${scaleValue(config.eyeSize)}px`;
  eyeball.style.height = `${scaleValue(config.eyeSize)}px`;
  eyeball.style.background = config.eyeColor;

  const pupil = document.createElement("div");
  pupil.className = "lp-eyePupil";
  pupil.style.width = `${scaleValue(config.pupilSize)}px`;
  pupil.style.height = `${scaleValue(config.pupilSize)}px`;
  pupil.style.background = config.pupilColor;

  eyeball.appendChild(pupil);
  return { wrapper: eyeball, moving: pupil, blinkTarget: eyeball, type: "eyeball", pupil };
}

function buildPupil(config) {
  const socket = document.createElement("div");
  socket.className = "lp-pupilSocket";

  const pupil = document.createElement("div");
  pupil.className = "lp-pupil";
  pupil.style.width = `${scaleValue(config.pupilSize)}px`;
  pupil.style.height = `${scaleValue(config.pupilSize)}px`;
  pupil.style.background = config.pupilColor;

  socket.appendChild(pupil);
  return { wrapper: socket, moving: pupil, blinkTarget: pupil, type: "pupil" };
}

function buildCharacterFace(config) {
  const charEl = config.element;
  if (!charEl) return null;

  charEl.replaceChildren();

  const eyeRow = document.createElement("div");
  eyeRow.className = config.eyeRowClass;
  eyeRow.style.transform = "translateX(-50%)";

  const movingEyes = [];
  const blinkParts = [];

  for (let i = 0; i < 2; i += 1) {
    const eye = config.eyeStyle === "eyeball" ? buildEyeBall(config) : buildPupil(config);
    eyeRow.appendChild(eye.wrapper);
    movingEyes.push(eye.moving);
    blinkParts.push(eye);
  }

  charEl.appendChild(eyeRow);

  let mouthEl = null;
  let mouthConfig = null;
  if (config.mouth) {
    mouthConfig = config.mouth;
    mouthEl = document.createElement("div");
    mouthEl.className = config.mouth.className + (config.mouth.smile ? " lp-mouthSmile" : "");
    charEl.appendChild(mouthEl);
  }

  return {
    ...config,
    eyeRow,
    movingEyes,
    blinkParts,
    mouthConfig,
    mouthEl,
    isBlinking: false,
    blinkTimerId: 0,
    blinkOpenTimerId: 0,
  };
}

function setBlinkState(state, isBlinking) {
  state.isBlinking = isBlinking;

  state.blinkParts.forEach((part) => {
    if (part.type === "eyeball") {
      part.blinkTarget.classList.toggle("lp-eyeballBlink", isBlinking);
      part.blinkTarget.style.height = `${isBlinking ? 2 : scaleValue(state.eyeSize)}px`;
      part.pupil.style.opacity = isBlinking ? "0" : "1";
    } else {
      part.blinkTarget.classList.toggle("lp-pupilBlink", isBlinking);
      part.blinkTarget.style.height = `${isBlinking ? 2 : scaleValue(state.pupilSize)}px`;
    }
  });
}

function startBlinking(state) {
  const scheduleNext = () => {
    if (disposed) return;

    state.blinkTimerId = window.setTimeout(() => {
      if (disposed) return;

      setBlinkState(state, true);
      state.blinkOpenTimerId = window.setTimeout(() => {
        if (disposed) return;

        setBlinkState(state, false);
        scheduleNext();
      }, 170);
    }, randomInRange(state.blinkMin, state.blinkMax));
  };

  scheduleNext();
}

function getActivePointer() {
  if (allowHovered && elAllow && !elActions.classList.contains("hidden")) {
    const rect = elAllow.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  return { x: mouseX, y: mouseY };
}

function updateCharacter(state, pointer) {
  const track = getCharacterTrack(state.element, pointer.x, pointer.y);
  const effectiveTrack = grantedState
    ? { deltaX: 0, deltaY: 0, skew: state.grantedSkew }
    : track;

  const eyeLeftOffset = scaleValue(
    clamp(effectiveTrack.deltaX / state.eyeLeftDivisor, -state.eyeLeftClamp, state.eyeLeftClamp)
  );
  const eyeTopOffset = scaleValue(
    clamp(effectiveTrack.deltaY / state.eyeTopDivisor, -state.eyeTopClamp, state.eyeTopClamp)
  );

  state.eyeRow.style.left = `calc(50% + ${eyeLeftOffset.toFixed(2)}px)`;
  state.eyeRow.style.top = `${(scaleValue(state.eyeTopBase) + eyeTopOffset).toFixed(2)}px`;

  const look = resolveLook({
    deltaX: effectiveTrack.deltaX,
    deltaY: effectiveTrack.deltaY,
    maxDistance: scaleValue(state.maxDistance),
    forceLookX: grantedState ? scaleValue(state.grantedLook.x) : undefined,
    forceLookY: grantedState ? scaleValue(state.grantedLook.y) : undefined,
  });

  const eyeScale = grantedState && state.eyeStyle === "pupil" ? 1.2 : 1;
  const eyeTransform = state.isBlinking
    ? `translate(0px, 0px) scale(${eyeScale})`
    : `translate(${look.x.toFixed(2)}px, ${look.y.toFixed(2)}px) scale(${eyeScale})`;

  state.movingEyes.forEach((eye) => {
    eye.style.transform = eyeTransform;
  });

  const skew = grantedState ? state.grantedSkew : effectiveTrack.skew;
  state.element.style.transform = `skewX(${skew.toFixed(2)}deg)`;

  if (state.mouthEl && state.mouthConfig) {
    const mouthX = grantedState
      ? 0
      : scaleValue(
          clamp(
            effectiveTrack.deltaX / state.mouthConfig.xDivisor,
            -state.mouthConfig.xClamp,
            state.mouthConfig.xClamp
          )
        );
    const mouthY = grantedState
      ? 0
      : scaleValue(
          clamp(
            effectiveTrack.deltaY / state.mouthConfig.yDivisor,
            -state.mouthConfig.yClamp,
            state.mouthConfig.yClamp
          )
        );

    state.mouthEl.style.transform = `translate(calc(-50% + ${mouthX.toFixed(2)}px), ${mouthY.toFixed(2)}px)`;
    state.mouthEl.classList.toggle("lp-mouthHappy", grantedState);
  }
}

function updateAllCharacters() {
  const pointer = getActivePointer();
  characterStates.forEach((state) => updateCharacter(state, pointer));
}

function animationLoop() {
  if (disposed) return;

  updateAllCharacters();
  animationFrameId = window.requestAnimationFrame(animationLoop);
}

function initCharacters() {
  Object.values(CHARACTERS).forEach((config) => {
    const state = buildCharacterFace(config);
    if (!state) return;

    characterStates.push(state);
    setBlinkState(state, false);
    updateCharacter(state, { x: mouseX, y: mouseY });
    startBlinking(state);
  });

  const onMouseMove = (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
  };

  const onResize = () => {
    mouseX = window.innerWidth / 2;
    mouseY = window.innerHeight / 2;
  };

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  window.addEventListener("resize", onResize);
  cleanupCallbacks.push(() => window.removeEventListener("mousemove", onMouseMove));
  cleanupCallbacks.push(() => window.removeEventListener("resize", onResize));

  if (elAllow) {
    const onAllowEnter = () => {
      allowHovered = true;
    };
    const onAllowLeave = () => {
      allowHovered = false;
    };

    elAllow.addEventListener("mouseenter", onAllowEnter);
    elAllow.addEventListener("mouseleave", onAllowLeave);
    cleanupCallbacks.push(() => elAllow.removeEventListener("mouseenter", onAllowEnter));
    cleanupCallbacks.push(() => elAllow.removeEventListener("mouseleave", onAllowLeave));
  }

  animationFrameId = window.requestAnimationFrame(animationLoop);
}

function cleanupAnimations() {
  if (disposed) return;

  disposed = true;
  if (animationFrameId) {
    window.cancelAnimationFrame(animationFrameId);
  }

  characterStates.forEach((state) => {
    window.clearTimeout(state.blinkTimerId);
    window.clearTimeout(state.blinkOpenTimerId);
  });

  cleanupCallbacks.forEach((cleanup) => cleanup());
}

try {
  if (!requestId || !rawUrl) throw new Error("Missing request");
  const parsedUrl = new URL(rawUrl);
  permissionOrigin = `${parsedUrl.origin}/*`;
  elTitle.textContent = "To track prices on ";
  const strong = document.createElement("strong");
  strong.textContent = domain || parsedUrl.hostname;
  elTitle.appendChild(strong);
  elTitle.append(", TRAKER needs access to this site.");
  elSummary.textContent = "Grant access once and TRAKER will continue to the product page.";
  elActions.classList.remove("hidden");
} catch {
  elTitle.textContent = "Invalid request";
  elSummary.textContent = "This permission request could not be opened.";
  elDetail.textContent = "Close this window and try again from the web app.";
  elInvalidActions.classList.remove("hidden");
}

elAllow?.addEventListener("click", async () => {
  setPendingState(true);
  try {
    const granted = await chrome.permissions.request({ origins: [permissionOrigin] });
    if (granted) {
      await chrome.runtime.sendMessage({ action: "permission_granted", requestId });
      grantedState = true;
      allowHovered = false;
      elScene?.classList.add("lp-emotionSuccess");
      elTitle.textContent = "Access granted!";
      elSummary.textContent = "Loading the product page...";
      elDetail.textContent = "";
      elActions.classList.add("hidden");
      updateAllCharacters();
      return;
    }
    await chrome.runtime.sendMessage({ action: "permission_denied", requestId });
    setTimeout(() => window.close(), 300);
  } catch (err) {
    console.warn("[Traker] permission request page failed:", err);
    try {
      await chrome.runtime.sendMessage({ action: "permission_denied", requestId });
      setTimeout(() => window.close(), 300);
    } catch {}
  }
});

elCancel?.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ action: "permission_denied", requestId });
  } catch (err) {
    console.warn("[Traker] permission deny message failed:", err);
  }
  // Background should close this tab, but close it ourselves as a fallback
  setTimeout(() => window.close(), 300);
});

elClose?.addEventListener("click", () => window.close());

window.addEventListener("beforeunload", cleanupAnimations, { once: true });
window.addEventListener("pagehide", cleanupAnimations, { once: true });

initCharacters();
