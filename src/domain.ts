// Domain types. Terms follow CONTEXT.md. All times are seconds of Conversation time.

export type SpeakerId = string;

export type Utterance = {
  id: string;
  speaker: SpeakerId;
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  speakers: SpeakerId[];
  utterances: Utterance[];
};

export type Claim = {
  id: string;
  /** The Claim restated so it stands alone without the Conversation. */
  text: string;
  /** What was actually said, as close to verbatim as Screening could quote it. */
  quote: string;
  speaker: SpeakerId;
  utteranceIds: string[];
};

export const VERDICTS = ["supported", "refuted", "misleading", "unverifiable"] as const;
export type VerdictLabel = (typeof VERDICTS)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type Source = {
  url: string;
  title: string;
};

export type Verdict = {
  label: VerdictLabel;
  confidence: Confidence;
  /** One short sentence saying what is actually true. */
  explanation: string;
  /** Whether getting this wrong would matter to the people in the Conversation. */
  important: boolean;
  sources: Source[];
  /** Whether full pages had to be read because snippets were not enough. */
  readPages: boolean;
};

export type Interjection = {
  claimId: string;
  at: number;
  text: string;
};

/** Why a Verification did or did not become an Interjection. */
export type InterjectionDecision =
  | { interject: true }
  | {
      interject: false;
      reason:
        | "verdict"
        | "confidence"
        | "unimportant"
        | "already-corrected"
        | "rate-limited";
    };
