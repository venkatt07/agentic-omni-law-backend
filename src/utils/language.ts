export interface LanguageDetection {
  code: string;
  label: string;
  confidence: number;
}

const LANGUAGE_LABELS: Record<string, string> = {
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  kn: "Kannada",
  ml: "Malayalam",
  gu: "Gujarati",
  pa: "Punjabi",
  or: "Odia",
  ur: "Urdu",
  en: "English",
  unknown: "Unknown",
};

export function detectLanguageInfo(text: string): LanguageDetection {
  const sample = (text || "").trim();
  if (!sample) return { code: "unknown", label: "Unknown", confidence: 0 };

  const counts: Record<string, number> = {
    hi: 0,
    ta: 0,
    te: 0,
    bn: 0,
    kn: 0,
    ml: 0,
    gu: 0,
    pa: 0,
    or: 0,
    ur: 0,
    en: 0,
    other: 0,
  };

  for (const ch of sample.slice(0, 6000)) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0900 && code <= 0x097f) counts.hi++; // Devanagari => hi default
    else if (code >= 0x0b80 && code <= 0x0bff) counts.ta++;
    else if (code >= 0x0c00 && code <= 0x0c7f) counts.te++;
    else if (code >= 0x0980 && code <= 0x09ff) counts.bn++; // Bengali/Assamese
    else if (code >= 0x0c80 && code <= 0x0cff) counts.kn++;
    else if (code >= 0x0d00 && code <= 0x0d7f) counts.ml++;
    else if (code >= 0x0a80 && code <= 0x0aff) counts.gu++;
    else if (code >= 0x0a00 && code <= 0x0a7f) counts.pa++; // Gurmukhi
    else if (code >= 0x0b00 && code <= 0x0b7f) counts.or++;
    else if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f) || (code >= 0x08a0 && code <= 0x08ff)) counts.ur++; // Arabic script
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) counts.en++;
    else if (!/\s|\d|[.,;:!?()[\]{}'"/\\\-–—?%&+*=<>@#]/.test(ch)) counts.other++;
  }

  const buckets = Object.entries(counts)
    .filter(([key]) => key !== "other")
    .map(([code, count]) => ({ code, count, label: LANGUAGE_LABELS[code] || code }))
    .sort((a, b) => b.count - a.count);

  const winner = buckets[0];
  const totalSignal = buckets.reduce((acc, b) => acc + b.count, 0) + counts.other;
  if (!winner || winner.count === 0) return { code: "unknown", label: "Unknown", confidence: 0.1 };

  const ratio = totalSignal > 0 ? winner.count / totalSignal : 0;
  let confidence = 0.55 + ratio * 0.45;
  if (winner.code !== "en" && winner.count >= 20) confidence = Math.max(confidence, 0.9);
  if (winner.code === "en" && counts.en >= 30) confidence = Math.max(confidence, 0.88);
  const activeScripts = buckets.filter((b) => b.count > 0).length;
  if (activeScripts > 1 && ratio < 0.65) confidence = Math.min(confidence, 0.78);

  return {
    code: winner.code,
    label: winner.label,
    confidence: Math.min(0.99, Number(confidence.toFixed(3))),
  };
}

export function detectLanguage(text: string): string {
  return detectLanguageInfo(text).label;
}
