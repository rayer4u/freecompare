import { createSignal } from "solid-js";
import { zhCN, I18nSchema } from "./zh-CN";
import { enUS } from "./en-US";
import { callRustRpc } from "../bridge";

export type Locale = "zh-CN" | "en-US";

const dictionaries: Record<Locale, I18nSchema> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

// Initial locale detection: localStorage -> navigator.language -> default "zh-CN"
function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem("fc_language") as Locale;
    if (saved === "zh-CN" || saved === "en-US") {
      return saved;
    }
    if (typeof navigator !== "undefined" && navigator.language) {
      if (navigator.language.toLowerCase().startsWith("en")) {
        return "en-US";
      }
    }
  } catch {
    // ignore
  }
  return "zh-CN";
}

const [currentLocale, setCurrentLocaleSignal] = createSignal<Locale>(getInitialLocale());

export { currentLocale };

export function setLocale(loc: Locale, persistToBackend = true) {
  if (loc !== "zh-CN" && loc !== "en-US") return;
  setCurrentLocaleSignal(loc);
  try {
    localStorage.setItem("fc_language", loc);
  } catch {
    // ignore
  }
  if (persistToBackend) {
    callRustRpc("update_user_preferences", { language: loc }).catch(() => {});
  }
}

export function toggleLocale() {
  const next: Locale = currentLocale() === "zh-CN" ? "en-US" : "zh-CN";
  setLocale(next);
}

/**
 * Access a nested translation string by dot path.
 * Example: t("header.settings") or t("text_diff.diff_count", { count: 5 })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const loc = currentLocale();
  const dict = dictionaries[loc] || dictionaries["zh-CN"];
  
  const keys = key.split(".");
  let val: unknown = dict;
  for (const k of keys) {
    if (val && typeof val === "object" && k in val) {
      val = (val as Record<string, unknown>)[k];
    } else {
      val = undefined;
      break;
    }
  }

  // Fallback to Chinese if not found in current dict
  if (typeof val !== "string") {
    let fallbackVal: unknown = dictionaries["zh-CN"];
    for (const k of keys) {
      if (fallbackVal && typeof fallbackVal === "object" && k in fallbackVal) {
        fallbackVal = (fallbackVal as Record<string, unknown>)[k];
      } else {
        fallbackVal = undefined;
        break;
      }
    }
    if (typeof fallbackVal === "string") {
      val = fallbackVal;
    } else {
      return key;
    }
  }

  let result = val as string;
  if (params) {
    for (const [pk, pv] of Object.entries(params)) {
      result = result.replaceAll(`{${pk}}`, String(pv));
    }
  }
  return result;
}
