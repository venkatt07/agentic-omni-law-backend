const dictionaries: Record<string, Record<string, string>> = {
  Hindi: {
    "Run completed": "रन पूरा हुआ",
    "Run failed": "रन विफल हुआ",
    "Refreshing index": "इंडेक्स रीफ़्रेश हो रहा है",
    "Index ready": "इंडेक्स तैयार है",
    "Generating final summary": "अंतिम सारांश तैयार किया जा रहा है",
    "Case analysis completed": "केस विश्लेषण पूरा हुआ",
    summary: "सारांश",
    confidence: "विश्वास",
    citations: "उद्धरण",
  },
  Tamil: {
    "Run completed": "இயக்கம் முடிந்தது",
    "Run failed": "இயக்கம் தோல்வியடைந்தது",
    "Refreshing index": "இண்டெக்ஸ் புதுப்பிக்கப்படுகிறது",
    "Index ready": "இண்டெக்ஸ் தயார்",
    "Generating final summary": "இறுதி சுருக்கம் உருவாக்கப்படுகிறது",
    "Case analysis completed": "வழக்கு பகுப்பாய்வு முடிந்தது",
    summary: "சுருக்கம்",
    confidence: "நம்பிக்கை",
    citations: "மேற்கோள்கள்",
  },
  Bengali: {
    "Run completed": "রান সম্পন্ন হয়েছে",
    "Run failed": "রান ব্যর্থ হয়েছে",
    "Refreshing index": "ইনডেক্স রিফ্রেশ হচ্ছে",
    "Index ready": "ইনডেক্স প্রস্তুত",
    "Generating final summary": "চূড়ান্ত সারাংশ তৈরি হচ্ছে",
    "Case analysis completed": "কেস বিশ্লেষণ সম্পন্ন হয়েছে",
    summary: "সারাংশ",
    confidence: "বিশ্বাস",
    citations: "উৎস",
  },
};

const stepNameMap: Record<string, Record<string, string>> = {
  Hindi: {
    index_refresh: "इंडेक्स रीफ़्रेश",
    query_parsing: "क्वेरी पार्सिंग",
    contract_risk: "कॉन्ट्रैक्ट रिस्क",
    outcome_projection: "आउटकम प्रोजेक्शन",
    policy_compliance: "पॉलिसी कंप्लायंस",
    legal_drafts_validation: "लीगल ड्राफ्ट वैलिडेशन",
    role_agents_parallel: "रोल एजेंट्स रन",
    final_summary: "अंतिम सारांश",
  },
  Tamil: {
    index_refresh: "இண்டெக்ஸ் புதுப்பிப்பு",
    query_parsing: "க்வெரி பார்சிங்",
    contract_risk: "ஒப்பந்த ஆபத்து",
    outcome_projection: "முடிவு கணிப்பு",
    policy_compliance: "கொள்கை இணக்கம்",
    legal_drafts_validation: "சட்ட வரைவு சரிபார்ப்பு",
    role_agents_parallel: "பங்கு ஏஜென்ட் இயக்கம்",
    final_summary: "இறுதி சுருக்கம்",
  },
  Bengali: {
    index_refresh: "ইনডেক্স রিফ্রেশ",
    query_parsing: "কোয়েরি পার্সিং",
    contract_risk: "কন্ট্রাক্ট রিস্ক",
    outcome_projection: "আউটকাম প্রজেকশন",
    policy_compliance: "পলিসি কমপ্লায়েন্স",
    legal_drafts_validation: "লিগ্যাল ড্রাফ্ট ভ্যালিডেশন",
    role_agents_parallel: "রোল এজেন্ট রান",
    final_summary: "চূড়ান্ত সারাংশ",
  },
};

function normalizeLanguageName(language?: string | null) {
  if (!language) return "English";
  const normalized = String(language).trim().toLowerCase();
  if (!normalized) return "English";
  if (normalized === "en" || normalized === "english") return "English";
  if (normalized === "hi" || normalized === "hindi") return "Hindi";
  if (normalized === "ta" || normalized === "tamil") return "Tamil";
  if (normalized === "bn" || normalized === "bengali") return "Bengali";
  return String(language).trim();
}

function shouldTranslate(sourceLanguage?: string | null, targetLanguage?: string | null) {
  const source = normalizeLanguageName(sourceLanguage);
  const target = normalizeLanguageName(targetLanguage);
  if (!target || target === "English") return false;
  return source !== target;
}

function translateText(text: string, language?: string): string {
  const target = normalizeLanguageName(language);
  const source = String(text || "").replace(/^\[(?:Hindi|Tamil|Bengali)\]\s*/i, "").trimStart();
  if (!target || target === "English") return source;
  const dict = dictionaries[target] || {};
  let out = source;
  for (const [from, to] of Object.entries(dict)) {
    out = out.replaceAll(from, to);
  }
  return out;
}

const PRESERVE_KEYS = new Set([
  "mode",
  "source_type",
  "source_label",
  "source_language",
  "doc_id",
  "chunk_id",
  "detected_language",
  "code",
  "confidence",
  "confidence_score",
  "case_id",
  "run_id",
  "input_hash",
  "doc_checksums_used",
  "generated_at",
  "model_profile",
  "filters_applied",
]);

function walk(value: any, language?: string, keyHint?: string): any {
  if (keyHint && PRESERVE_KEYS.has(keyHint)) return value;
  if (typeof value === "string") return translateText(value, language);
  if (Array.isArray(value)) return value.map((v) => walk(v, language, keyHint));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, language, k)]));
  }
  return value;
}

export const translatorService = {
  normalizeLanguageName,
  shouldTranslate,
  translateText,
  translatePayload<T>(payload: T, language?: string, sourceLanguage?: string | null): T {
    if (!shouldTranslate(sourceLanguage, language)) return payload;
    return walk(payload, language) as T;
  },
  translateStepName(stepName: string, language?: string) {
    const target = normalizeLanguageName(language);
    if (!target || target === "English") return stepName;
    return stepNameMap[target]?.[stepName] ?? stepName;
  },
};
