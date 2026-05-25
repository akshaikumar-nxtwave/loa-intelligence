"use client";
import { useState, useRef, useCallback } from "react";
import {
  Upload,
  Sparkles,
  Send,
  Zap,
  FileText,
  Edit2,
  Link2,
  FileSpreadsheet,
  Copy,
  Check,
  ExternalLink,
  Code,
  BriefcaseBusiness,
  X,
} from "lucide-react";

/* ─── Types ─────────────────────────────────────────────────── */
interface JDData {
  company: string;
  companylinkedinlink: string;
  companywebsite: string;
  responseformname: string;
  role: string;
  stipend: string;
  location: string;
  duration: string;
  skills: string;
  timing: string;
  interview_mode: string;
  interview_rounds: string;
  jd: string;
  techstack: string;
  uid: string;
}

interface ApiResponse {
  success: boolean;
  formId?: string;
  formTitle?: string;
  formUrl?: string;
  formEditUrl?: string;
  prefilledUrl?: string;
  responseSheetUrl?: string;
  responseSheetTabId?: number;
  responseSheetTabName?: string;
  company?: string;
  error?: string;
}

type Step = "upload" | "extracting" | "review" | "sending" | "done";

/* ─── Helpers ────────────────────────────────────────────────── */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const PROMPT = `You are a HubSpot job posting data extractor. Extract ONLY these fields from the image(s) and return valid JSON.

MAPPING RULES:
- company: From "Association" field
- companylinkedinlink: FROM "LinkedIn company page"
- companywebsite: FROM "Website URL"
- role: From "Role Name" under Job Details
- stipend: IF Range of stipend is specified, extract From "Min internship stipend" and "Max internship stipend" give it in (- separated, for eg: "Min internship Stipend value-Max internship Stipend value"), If both MIN and MAX are same give the "MIN internship stipend" (digits only, no currency, give in numeric thousand format if mentioned as 15 give it in 15000, if zeros are mentioned dont add more zeors to it)
- location: From "Location" field
- duration: From "Internship Duration" (e.g., transform "Six Months" into "6 Months")
- skills: From "Mandatory Technologies Required" ONLY (mandatory, not optional)
- timing: From "No. of Working Days and Work Timings" field  (e.g., transform "9-6" into "9 AM - 6 PM" and give "6 days a week, 9 AM - 6 PM" or "5 days a week, 10 AM - 5 PM" etc based on the info given in the field give "No.of working days a week, Work Timings")
- interview_mode: From "Mode of Interview Process"
- interview_rounds: From "Online Interview Rounds" and "Offline Interview Rounds"
- techstack: FROM "Job Track

CRITICAL:
- If field missing, use "--"
- Stipend: digits only
- Duration: Extract the "Internship Duration" value, but strictly convert any words into numbers (e.g., transform "Six Months" into "6 Months").
- Skills: Use comma separation for multiple
- Interview rounds: List all rounds, format should be "Round Name(Type)" (e.g., "Technical Round 1(Online), HR(Offline)", "Technical Round(Online), HR(Online)" etc extact round name and based on the mode mentioned for each round)
- jd: MUST contain ONLY: Company, Role, Stipend, Location, Duration, Skills Required, Work Timings, Mode of Interview, Interview Rounds separated by \\n

Return ONLY valid JSON, no explanations:
{
  "company": "",
  "companylinkedinlink": "",
  "companywebsite": "",
  "role": "",
  "stipend": "",
  "location": "",
  "duration": "",
  "skills": "",
  "timing": "",
  "interview_mode": "",
  "interview_rounds": "",
  "jd": "\nCompany: ...\\nRole: ...\\nStipend: ...\\nLocation: ...\\nDuration: ...\\nSkills Required: ...\\nWork Timings: ...\\nMode of Interview: ...\\nInterview Rounds: ...\n",
  "techstack": "",
  "uid": ""
}`;

const AS_URL = process.env.NEXT_PUBLIC_AS_URL as string;
const MAX_IMAGES = 3;

function normalizeDuration(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `${trimmed} Months`;
  return trimmed;
}

function extractJsonObject(text: string): string | null {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function sanitizeJsonString(jsonText: string): string {
  let inString = false;
  let escaped = false;
  let result = "";

  for (let i = 0; i < jsonText.length; i++) {
    const char = jsonText[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += "\\";
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += '"';
      continue;
    }

    if (inString) {
      if (char === "\n") {
        result += "\\n";
        continue;
      }
      if (char === "\r") {
        result += "\\r";
        continue;
      }
      if (char === "\t") {
        result += "\\t";
        continue;
      }
      if (char < " ") {
        result += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    }

    result += char;
  }

  return result;
}

async function extractFromMistral(
  base64Array: string[],
  mimeArray: string[],
): Promise<JDData> {
  const key = process.env.NEXT_PUBLIC_MISTRAL_API_KEY as string;

  // Build content array with all images
  const imageContent = base64Array.map((base64, index) => ({
    type: "image_url" as const,
    image_url: { url: `data:${mimeArray[index]};base64,${base64}` },
  }));

  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "pixtral-12b-2409",
      messages: [
        {
          role: "user",
          content: [...imageContent, { type: "text", text: PROMPT }],
        },
      ],
      max_tokens: 1024,
    }),
  });

  if (!res.ok)
    throw new Error(`Mistral error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const rawContent = json.choices?.[0]?.message?.content;
  const text = Array.isArray(rawContent)
    ? rawContent
        .map((item: any) =>
          typeof item === "string" ? item : (item?.text ?? ""),
        )
        .join("")
    : String(rawContent ?? "");

  const jsonText = extractJsonObject(text);
  if (!jsonText) throw new Error("No JSON found in AI response");

  try {
    return JSON.parse(jsonText) as JDData;
  } catch (error) {
    const sanitized = sanitizeJsonString(jsonText);
    return JSON.parse(sanitized) as JDData;
  }
}

function buildWhatsappTemplate(data: JDData) {
  return `Hi Student 👋
Internship opportunity with *${data.company}*
Company JD:
${data.jd}
Company LinkedIn: ${data.companylinkedinlink}
Company Website: ${data.companywebsite}

👉 Apply here: https://forms.ccbp.in/${data.company.split(" ").join("").toLocaleLowerCase()}
Learning Material: https://comfortable-valley-8f0.notion.site/Placement-Preparation-Guide-33a7bfa973ff80eabaf1de7b17d0b4be
 
📌 Everyone must fill the form (if not interested → select NO). Shortlisted candidates will receive further updates.`;
}

async function sendToAppsScript(
  payload: Pick<
    JDData,
    | "company"
    | "responseformname"
    | "jd"
    | "techstack"
    | "location"
    | "duration"
    | "stipend"
    | "timing"
    | "uid"
  >,
): Promise<ApiResponse> {
  const res = await fetch(AS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ApiResponse>;
}

/* ─── Field config ───────────────────────────────────────────── */
const FIELDS: {
  key: keyof JDData;
  label: string;
  hint?: string;
  multiline?: boolean;
}[] = [
  { key: "company", label: "Company" },
  { key: "companylinkedinlink", label: "Company LinkedIn" },
  { key: "companywebsite", label: "Company Website" },
  {
    key: "responseformname",
    label: "Response Sheet Name",
    hint: "auto: Company – Role",
  },
  { key: "role", label: "Role" },
  { key: "stipend", label: "Stipend", hint: "Min-Max" },
  { key: "location", label: "Location" },
  { key: "duration", label: "Duration", hint: "e.g. 6 Months" },
  { key: "skills", label: "Skills", hint: "comma-separated" },
  { key: "timing", label: "Work Timings" },
  { key: "interview_mode", label: "Interview Mode" },
  {
    key: "interview_rounds",
    label: "Interview Rounds",
    hint: "comma-separated",
  },
  { key: "techstack", label: "Tech Stack" },
  { key: "uid", label: "UID" },
  {
    key: "jd",
    label: "JD Text",
    hint: "sent as-is to Google Form",
    multiline: true,
  },
];

/* ─── Spinner ────────────────────────────────────────────────── */
function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      className={`${className} animate-spin`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8H4z"
      />
    </svg>
  );
}

/* ─── Shared sidebar (images + meta) ─────────────────────────── */
function ImageSidebar({
  previews,
  files,
  aiData,
  onReset,
  onRemoveImage,
  resetLabel = "Start over",
}: {
  previews: string[];
  files: File[];
  aiData: JDData | null;
  onReset: () => void;
  onRemoveImage: (index: number) => void;
  resetLabel?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sticky top-20">
      <p className="text-xs font-semibold text-black uppercase tracking-wide mb-3">
        Source images ({previews.length}/{MAX_IMAGES})
      </p>

      {previews.length > 0 && (
        <div className="grid grid-cols-1 gap-2 mb-3">
          {previews.map((preview, index) => (
            <div key={index} className="relative group">
              <img
                src={preview}
                alt={`JD source ${index + 1}`}
                className=" rounded-xl object-cover border border-slate-100"
              />
              <button
                onClick={() => onRemoveImage(index)}
                className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove image"
              >
                <X className="w-3 h-3" />
              </button>
              <p className="text-[9px] text-black mt-1 truncate">
                {files[index]?.name}
              </p>
            </div>
          ))}
        </div>
      )}

      {aiData && (
        <details className="mt-3">
          <summary className="text-xs text-black cursor-pointer hover:text-slate-600 select-none">
            Raw AI output
          </summary>
          <pre className="mt-2 text-[10px] text-black bg-gray-100 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(aiData, null, 2)}
          </pre>
        </details>
      )}

      <button
        onClick={onReset}
        className="mt-4 w-full text-xs text-black hover:text-red-500 border border-slate-100 hover:border-red-200 rounded-xl py-2 transition-colors flex items-center justify-center gap-1.5"
      >
        <svg
          className="w-3 h-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        {resetLabel}
      </button>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────── */
export default function Dashboard() {
  const [step, setStep] = useState<Step>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [aiData, setAiData] = useState<JDData | null>(null);
  const [form, setForm] = useState<JDData | null>(null);
  const [apiResp, setApiResp] = useState<ApiResponse | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [whatsappTemplate, setWhatsappTemplate] = useState<string>("");

  const handleCopy = (
    text: string | undefined,
    id: string,
    duration = 2000,
  ) => {
    if (!text) return;

    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), duration);
  };

  const pickFiles = useCallback(
    (newFiles: FileList) => {
      const validFiles: File[] = [];

      for (let i = 0; i < newFiles.length; i++) {
        const f = newFiles[i];
        if (!f.type.startsWith("image/")) {
          setError(
            `File "${f.name}" is not an image. Please upload image files only.`,
          );
          continue;
        }
        validFiles.push(f);
      }

      if (validFiles.length === 0) return;

      // Check total limit
      const totalFiles = files.length + validFiles.length;
      if (totalFiles > MAX_IMAGES) {
        setError(
          `Maximum ${MAX_IMAGES} images allowed. You're trying to add ${validFiles.length} files.`,
        );
        return;
      }

      setError(null);

      // Add new files and previews
      const newPreviews = validFiles.map((f) => URL.createObjectURL(f));
      setFiles((prev) => [...prev, ...validFiles]);
      setPreviews((prev) => [...prev, ...newPreviews]);
    },
    [files.length],
  );

  const removeImage = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
  };

  /* Full reset — clears everything */
  const reset = () => {
    setStep("upload");
    previews.forEach((p) => URL.revokeObjectURL(p));
    setFiles([]);
    setPreviews([]);
    setAiData(null);
    setForm(null);
    setApiResp(null);
    setError(null);
    setSendError(null);
  };

  /* Go back to review WITHOUT clearing any data */
  const backToReview = () => {
    setSendError(null);
    setApiResp(null);
    setStep("review");
  };

  const extract = async () => {
    if (files.length === 0) return;
    setStep("extracting");
    setError(null);
    try {
      const base64Array = await Promise.all(files.map((f) => toBase64(f)));
      const mimeArray = files.map((f) => f.type);

      const data = await extractFromMistral(base64Array, mimeArray);
      const normalized = {
        ...data,
        companylinkedinlink: data.companylinkedinlink || "--",
        companywebsite: data.companywebsite || "--",
        duration: normalizeDuration(data.duration || ""),
      };
      const formname = `${normalized.company} - ${normalized.role}`;
      const payload = { ...normalized, responseformname: formname };
      setAiData(payload);
      setForm(payload);
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed");
      setStep("upload");
    }
  };

  const send = async () => {
    if (!form) return;
    setStep("sending");
    setSendError(null);
    const template = buildWhatsappTemplate(form);
    setWhatsappTemplate(template);

    try {
      const resp = await sendToAppsScript({
        company: form.company,
        responseformname: form.responseformname,
        jd: form.jd,
        techstack: form.techstack,
        location: form.location,
        duration: `${form.duration}`,
        stipend: `${form.stipend}`,
        timing: form.timing,
        uid: form.uid,
      });
      setApiResp(resp);
      setStep("done");
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Submission failed");
      setApiResp({
        success: false,
        error: e instanceof Error ? e.message : "Submission failed",
      });
      setStep("done");
    }
  };

  const setField = (key: keyof JDData, val: string) =>
    setForm((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, [key]: val };
      if (key === "company" || key === "role") {
        const autoName = `${key === "company" ? val : prev.company} - ${key === "role" ? val : prev.role}`;
        if (prev.responseformname === `${prev.company} - ${prev.role}`)
          updated.responseformname = autoName;
      }
      return updated;
    });

  /* ── Step indicator ── */
  const steps = ["Upload", "Review & Edit", "Done"];
  const stepIdx =
    step === "upload" || step === "extracting"
      ? 0
      : step === "review" || step === "sending"
        ? 1
        : 2;

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <span className="font-semibold text-slate-800 text-sm">
              JD Extractor
            </span>
            <span className="text-black/80 text-xs hidden sm:block">
              · HubSpot internship posting processor (up to 3 images)
            </span>
          </div>
          {step !== "upload" && (
            <button
              onClick={reset}
              className="text-xs text-black hover:text-red-500 flex items-center gap-1 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Clear & start over
            </button>
          )}
        </div>
      </header>

      <div className="max-w-full mx-auto px-6 py-8">
        {/* Step bar */}
        <div className="flex items-center gap-0 mb-8">
          {steps.map((label, i) => (
            <div key={i} className="flex items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all
                  ${i <= stepIdx ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-300 text-slate-400"}`}
                >
                  {i < stepIdx ? (
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={`text-xs font-medium hidden sm:block ${i <= stepIdx ? "text-blue-600" : "text-slate-400"}`}
                >
                  {label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`h-px w-10 mx-3 ${i < stepIdx ? "bg-blue-600" : "bg-slate-200"}`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Upload error banner */}
        {error && (
          <div className="mb-6 flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
            <svg
              className="w-4 h-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="12" cy="12" r="10" />
              <path strokeLinecap="round" d="M12 8v4m0 4h.01" />
            </svg>
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-400 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        )}

        {/* ══ STEP 1: Upload ══ */}
        {(step === "upload" || step === "extracting") && (
          <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full">
            {/* Top Section: Drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                pickFiles(e.dataTransfer.files);
              }}
              className={`rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center gap-4 cursor-pointer overflow-hidden
        ${previews.length > 0 ? "p-0 border-transparent bg-transparent" : "min-h-80 p-8 border-slate-300 bg-white hover:border-blue-400 hover:bg-slate-50"}
        ${drag ? "border-blue-500 bg-blue-50" : ""}`}
              onClick={() => previews.length === 0 && inputRef.current?.click()}
            >
              {previews.length > 0 ? (
                <div className="flex flex-col gap-3 bg-white border border-slate-200 p-5 rounded-2xl shadow-sm w-full">
                  {/* Images Grid */}
                  <div className="grid grid-cols-3 gap-3">
                    {previews.map((preview, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={preview}
                          alt={`JD preview ${index + 1}`}
                          className="w-full rounded-xl object-cover border border-slate-200/60 shadow-sm"
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeImage(index);
                          }}
                          className="absolute top-1.5 right-1.5 bg-red-500 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove image"
                        >
                          <X className="w-3 h-3" />
                        </button>
                        <span className="absolute bottom-1.5 left-1.5 bg-blue-600 text-white text-xs px-2 py-0.5 rounded font-medium">
                          {index + 1}/{previews.length}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* File names and controls */}
                  <div className="border-t border-slate-100 pt-3 mt-1">
                    <p className="text-xs text-slate-600 mb-2 font-medium">
                      Images ({previews.length}/{MAX_IMAGES})
                    </p>
                    <div className="space-y-1 mb-3">
                      {files.map((f, i) => (
                        <p key={i} className="text-xs text-slate-500 truncate">
                          {i + 1}. {f.name}
                        </p>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      {previews.length < MAX_IMAGES && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            inputRef.current?.click();
                          }}
                          className="text-xs text-blue-600 font-semibold hover:text-blue-700 underline underline-offset-2 transition-all"
                        >
                          Add more images
                        </button>
                      )}
                      {previews.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            reset();
                          }}
                          className="text-xs text-red-600 font-semibold hover:text-red-700 underline underline-offset-2 transition-all"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
                    <svg
                      className="w-7 h-7 text-blue-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18M3.75 3h16.5A.75.75 0 0121 3.75v12a.75.75 0 01-.75.75H3.75A.75.75 0 013 15.75V3.75A.75.75 0 013.75 3z"
                      />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-slate-700">
                      Drop your HubSpot JD images here
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      PNG, JPG, WEBP — up to {MAX_IMAGES} images
                    </p>
                  </div>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) pickFiles(e.target.files);
                }}
              />
            </div>

            {/* Bottom Section: Info Steps + Execution Action CTA */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col gap-6 shadow-sm">
              {/* Top Heading */}
              <div>
                <h2 className="font-semibold text-slate-800 text-sm mb-1">
                  How it works
                </h2>
                <p className="text-xs text-black/80">
                  3 simple steps to create your internship form
                </p>
              </div>

              {/* Step Items Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  {
                    icon: Upload,
                    title: "Upload JD images",
                    desc: "Upload up to 3 screenshots of your HubSpot job posting",
                  },
                  {
                    icon: Sparkles,
                    title: "AI extraction",
                    desc: "Mistral Vision AI reads and extracts all fields",
                  },
                  {
                    icon: Send,
                    title: "Review & send",
                    desc: "Edit if needed, then create the Google Form",
                  },
                ].map((item, i) => (
                  <div
                    key={i}
                    className="flex gap-3 items-start p-3 bg-slate-50/50 rounded-xl border border-slate-100"
                  >
                    <div className="p-1.5 bg-white border border-slate-100 rounded-lg text-slate-600 flex items-center justify-center mt-0.5 shrink-0 shadow-sm">
                      <item.icon className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-700">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Bottom Section: Action Button */}
              <div className="pt-2 border-t border-slate-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    extract();
                  }}
                  disabled={files.length === 0 || step === "extracting"}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl px-4 py-3.5 flex items-center justify-center gap-2 transition-colors shadow-sm"
                >
                  {step === "extracting" ? (
                    <>
                      <Spinner /> Extracting with AI…
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 fill-current" />
                      Extract JD Data ({files.length}/{MAX_IMAGES} images)
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ STEP 2: Review & Edit ══ */}
        {(step === "review" || step === "sending") && form && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Adjusted wrapper for scrolling */}
            <div className="lg:col-span-2 h-[calc(100vh-100px)] overflow-y-auto custom-scrollbar">
              <ImageSidebar
                previews={previews}
                files={files}
                aiData={aiData}
                onReset={reset}
                onRemoveImage={removeImage}
              />
            </div>
            <div className="lg:col-span-1">
              {/* The container is constrained to a fixed height (e.g., 600px or screen-based max-h-[calc(100vh-200px)]) */}
              <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col h-212 overflow-hidden shadow-sm">
                {/* Static Header */}
                <div className="shrink-0">
                  <h2 className="font-semibold text-slate-800 text-sm mb-1">
                    Review & edit extracted data
                  </h2>
                  <p className="text-xs text-black/80 mb-6">
                    All fields are editable. Confirm before sending to Google
                    Apps Script.
                  </p>
                </div>

                {/* Scrollable Fields Wrapper */}
                <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                  {FIELDS.map(({ key, label, hint, multiline }) => (
                    <div
                      key={key}
                      className="grid grid-cols-[140px_1fr] gap-3 items-start"
                    >
                      <div className="pt-2 text-right">
                        <label className="text-xs font-medium text-black">
                          {label}
                        </label>
                        {hint && (
                          <p className="text-[10px] text-black/80">{hint}</p>
                        )}
                      </div>
                      {multiline ? (
                        <textarea
                          value={`${form[key]}`}
                          onChange={(e) => setField(key, e.target.value)}
                          rows={6}
                          className="w-full h-44 min-h-30 text-xs font-mono border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y bg-slate-50"
                        />
                      ) : (
                        <input
                          type="text"
                          value={form[key]}
                          onChange={(e) => setField(key, e.target.value)}
                          className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-slate-50 h-9"
                        />
                      )}
                    </div>
                  ))}
                </div>

                {/* Static Footer Actions */}
                <div className="flex gap-3 mt-6 pt-4 border-t border-slate-100 shrink-0">
                  <button
                    onClick={reset}
                    disabled={step === "sending"}
                    className="px-4 py-2.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                    Clear all
                  </button>
                  <button
                    onClick={send}
                    disabled={step === "sending"}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-xl px-4 py-2.5 flex items-center justify-center gap-2 transition-colors"
                  >
                    {step === "sending" ? (
                      <>
                        <Spinner /> Creating Google Form…
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                          />
                        </svg>
                        Create Google Form
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══ STEP 3: Done ══ */}
        {step === "done" && apiResp && form && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: image sidebar */}
            <div className="lg:col-span-1">
              <ImageSidebar
                previews={previews}
                files={files}
                aiData={aiData}
                onReset={reset}
                onRemoveImage={removeImage}
                resetLabel="Clear & start over"
              />
            </div>

            {/* Right: results panel */}
            <div className="lg:col-span-2 space-y-4">
              {/* Status banner */}
              {apiResp.success ? (
                <div className="bg-green-50 border border-green-200 rounded-2xl px-5 py-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-green-800">
                      Form created successfully!
                    </p>
                    {apiResp.formTitle && (
                      <p className="text-xs text-green-600 mt-0.5">
                        {apiResp.formTitle}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={backToReview}
                    className="ml-auto text-xs text-green-600 hover:text-green-800 border border-green-200 hover:border-green-400 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    Edit & resend
                  </button>
                </div>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-red-800">
                      Submission failed
                    </p>
                    <p className="text-xs text-red-500 mt-0.5">
                      {sendError ?? apiResp.error ?? "Unknown error"}
                    </p>
                  </div>
                  <button
                    onClick={backToReview}
                    className="ml-auto text-xs text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap"
                  >
                    ← Try again
                  </button>
                </div>
              )}

              {/* All response fields */}
              {apiResp.success && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                      Response values
                    </p>
                    <span className="text-[10px] text-black">
                      All fields from the API
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                    {/* Metadata Text Rows */}
                    {[
                      {
                        id: "form-id",
                        label: "Form ID",
                        value: apiResp?.formId,
                      },
                      {
                        id: "form-title",
                        label: "Form Title",
                        value: apiResp?.formTitle,
                      },
                      {
                        id: "sheet-tab",
                        label: "Sheet Tab Name",
                        value: apiResp?.responseSheetTabName,
                      },
                    ]
                      .filter((r) => r.value)
                      .map((row) => (
                        <div
                          key={row.id}
                          className="grid grid-cols-[160px_1fr_auto] gap-3 px-5 py-3 items-center hover:bg-slate-50/50 transition-colors group"
                        >
                          <span className="text-xs font-medium text-black">
                            {row.label}
                          </span>
                          <span className="text-xs font-mono text-black break-all select-all">
                            {row.value}
                          </span>
                          <button
                            onClick={() => handleCopy(row.value || "", row.id)}
                            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors md:opacity-0 group-hover:opacity-100 focus:opacity-100"
                            title="Copy value"
                          >
                            {copiedId === row.id ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      ))}

                    {/* URL Action Rows */}
                    {[
                      {
                        id: "form-url",
                        label: "Form URL",
                        url: apiResp?.formUrl,
                        icon: FileText,
                      },
                      {
                        id: "edit-url",
                        label: "Edit Form URL",
                        url: apiResp?.formEditUrl,
                        icon: Edit2,
                      },
                      {
                        id: "prefill-url",
                        label: "Pre-filled URL",
                        url: apiResp?.prefilledUrl,
                        icon: Link2,
                      },
                      {
                        id: "sheet-url",
                        label: "Response Sheet",
                        url: apiResp?.responseSheetUrl,
                        icon: FileSpreadsheet,
                      },
                    ]
                      .filter((r) => r.url)
                      .map((row) => (
                        <div
                          key={row.id}
                          className="grid grid-cols-[160px_1fr_auto] gap-3 px-5 py-3 items-center hover:bg-slate-50/50 transition-colors group"
                        >
                          <span className="text-xs font-medium text-black">
                            {row.label}
                          </span>
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:text-blue-800 hover:underline break-all flex items-center gap-2 group/link"
                          >
                            <div className="p-1 bg-slate-50 border border-slate-100 rounded text-slate-500 shrink-0">
                              <row.icon className="w-3 h-3" />
                            </div>
                            <span className="break-all font-mono text-[11px] leading-relaxed">
                              {row.url}
                            </span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-40 group-hover/link:opacity-100 transition-opacity text-slate-400 group-hover/link:text-blue-600" />
                          </a>
                          <button
                            onClick={() => handleCopy(row.url || "", row.id)}
                            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors md:opacity-0 group-hover:opacity-100 focus:opacity-100"
                            title="Copy link"
                          >
                            {copiedId === row.id ? (
                              <Check className="w-3.5 h-3.5 text-green-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      ))}
                    {/* Pre-fill Code Row */}
                    {apiResp?.prefilledUrl && (
                      <div className="grid grid-cols-[160px_1fr_auto] gap-3 px-5 py-3 items-center hover:bg-slate-50/50 transition-colors group">
                        {/* Column 1: Label */}
                        <span className="text-xs font-medium text-black">
                          Pre-fill Code
                        </span>

                        {/* Column 2: Icon + Code Content */}
                        <div className="flex items-center gap-2 overflow-hidden">
                          <div className="p-1 bg-slate-50 border border-slate-100 rounded text-slate-500 shrink-0">
                            <Code className="w-3 h-3" />
                          </div>
                          <span className="text-xs font-mono text-slate-700 break-all select-all leading-relaxed">
                            {apiResp.prefilledUrl
                              .split("&")[1]
                              ?.split("=")[0] || ""}
                          </span>
                        </div>

                        {/* Column 3: Copy Action Button */}
                        <button
                          onClick={() =>
                            handleCopy(
                              apiResp.prefilledUrl
                                ?.split("&")[1]
                                ?.split("=")[0] || "",
                              "prefill-code",
                            )
                          }
                          className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors md:opacity-0 group-hover:opacity-100 focus:opacity-100"
                          title="Copy code"
                        >
                          {copiedId === "prefill-code" ? (
                            <Check className="w-3.5 h-3.5 text-green-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                    {apiResp?.formTitle && (
                      <div className="grid grid-cols-[160px_1fr_auto] gap-3 px-5 py-3 items-center hover:bg-slate-50/50 transition-colors group">
                        {/* Column 1: Label */}
                        <span className="text-xs font-medium text-black">
                          Company Name
                        </span>

                        {/* Column 2: Icon + Code Content */}
                        <div className="flex items-center gap-2 overflow-hidden">
                          <div className="p-1 bg-slate-50 border border-slate-100 rounded text-slate-500 shrink-0">
                            <BriefcaseBusiness className="w-3 h-3" />
                          </div>
                          <span className="text-xs font-mono text-slate-700 break-all select-all leading-relaxed">
                            {apiResp?.formTitle ||
                              ""}
                          </span>
                        </div>

                        {/* Column 3: Copy Action Button */}
                        <button
                          onClick={() =>
                            handleCopy(
                              apiResp?.formTitle &&
                                apiResp?.formTitle.split(/\s*[\-\–\—]\s*/)[1],
                              "prefill-code",
                            )
                          }
                          className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors md:opacity-0 group-hover:opacity-100 focus:opacity-100"
                          title="Copy code"
                        >
                          {copiedId === "prefill-code" ? (
                            <Check className="w-3.5 h-3.5 text-green-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* WhatsApp template */}
                  <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          WhatsApp template
                        </p>
                        <p className="text-xs text-slate-500">
                          Edit the message before copying. Dynamic fields come
                          from the extracted JD data.
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          handleCopy(
                            whatsappTemplate,
                            "whatsapp-template",
                            1200,
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
                      >
                        {copiedId === "whatsapp-template" ? (
                          <>
                            <Check className="w-3.5 h-3.5" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" /> Copy template
                          </>
                        )}
                      </button>
                    </div>
                    <textarea
                      value={whatsappTemplate}
                      onChange={(e) => setWhatsappTemplate(e.target.value)}
                      rows={10}
                      className="w-full text-xs font-mono border border-slate-200 rounded-2xl px-3 py-3 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white resize-y"
                    />
                  </div>

                  {/* Raw JSON dropdown */}
                  <details className="border-t border-slate-100">
                    <summary className="px-5 py-3 text-xs text-black cursor-pointer hover:bg-slate-50 select-none flex items-center gap-2 transition-colors">
                      <Code className="w-3.5 h-3.5" />
                      Raw API response
                    </summary>
                    <div className="px-5 pb-4">
                      <pre className="text-[11px] text-black bg-gray-100 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                        {JSON.stringify(apiResp, null, 2)}
                      </pre>
                    </div>
                  </details>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
