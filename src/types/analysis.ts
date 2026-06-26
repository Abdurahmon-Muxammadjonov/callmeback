export interface TranscriptLine {
  speaker: 'manager' | 'customer';
  text: string;
}

export interface CallAnalysisResult {
  transcript_structured: TranscriptLine[];
  scores: {
    salomlashish: number;
    ehtiyoj_aniqlash: number;
    mahsulot_tushuntirish: number;
    etirozlar_bilan_ishlash: number;
    keyingi_qadam: number;
    umumiy_baho: number;
  };
  checklist: {
    asked_for_budget: boolean;
    handled_price_objection: boolean;
    scheduled_follow_up: boolean;
  };
  summary: string;
  manager_mistakes: string[];
  recommendations: string[];
  lost_reason: string | null;
  lost_reason_details: string | null;
}

export interface AnalyzeCallRequest {
  audio_url: string; // Made strictly required as per API requirements
  manager_id: string; // Strictly required
  manager_name?: string;
  client_phone?: string; // Optional client phone
  duration?: number;
}

export interface AnalyzeCallResponse {
  success: boolean;
  data?: {
    callId: string;
    analysis: CallAnalysisResult;
    dailyCallCount?: number;
    warnings?: string[];
  };
  error?: string;
}

// Database Row Types (reflecting supabase/schema.sql)
export interface ManagerRow {
  id: string;
  name: string;
  created_at: string;
}

export interface CallRow {
  id: string;
  manager_id: string;
  client_phone: string;
  audio_url: string | null;
  duration: number | null;
  created_at: string;
}

export interface TranscriptRow {
  id: string;
  call_id: string;
  raw_text: string;
  structured_text: TranscriptLine[];
  created_at: string;
}

export interface AnalysisScoresRow {
  id: string;
  call_id: string;
  salomlashish: number;
  ehtiyoj_aniqlash: number;
  mahsulot_tushuntirish: number;
  etirozlar_bilan_ishlash: number;
  keyingi_qadam: number;
  umumiy_baho: number;
  asked_for_budget: boolean;
  handled_price_objection: boolean;
  scheduled_follow_up: boolean;
  summary: string;
  manager_mistakes: string[];
  recommendations: string[];
  created_at: string;
}

export interface LostReasonRow {
  id: string;
  call_id: string;
  reason: string;
  details: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  age: number | null;
  phone: string | null;
  role: string;
  created_at: string;
}
