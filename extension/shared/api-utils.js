// shared/api-utils.js — Shared utilities for popup.js and background.js
// Loaded via <script> in popup.html and importScripts() in background.js

const DEFAULT_FREQUENCY = "24h";
const FREQUENCY_VALUES = new Set(["6h", "12h", "24h", "7d", "30d"]);

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

async function extFetch(url, options = {}) {
  const { authToken = "" } = await getStorage(["authToken"]);
  const headers = { ...(options.headers || {}) };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return fetch(url, { ...options, headers });
}

function normalizeFrequency(value) {
  if (!value) return DEFAULT_FREQUENCY;
  return FREQUENCY_VALUES.has(value) ? value : DEFAULT_FREQUENCY;
}

function normalizeThreshold(value) {
  if (value === "" || value == null) return "";
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return "";
  return num;
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function parseResponseBody(resp) {
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return resp.json().catch(() => ({}));
  }
  const text = await resp.text().catch(() => "");
  return text ? { detail: text } : {};
}

function extractApiErrorMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  const detail = payload.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    if (typeof detail.error === "string") return detail.error;
    if (typeof detail.message === "string") return detail.message;
  }
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.message === "string") return payload.message;
  return "";
}
