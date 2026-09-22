/**
 * Drafter core types: one reviewed base (the brief), many versions written
 * for different specs. See docs/CHANNEL_DRAFTER_DESIGN.md.
 *
 * The core knows a version's target only as a `VersionSpec`. The channel
 * drafter is the first workflow on this core; its `ChannelProfile` extends
 * the spec with limits, threads and slots. Nothing in the core types may
 * mention a channel.
 */
import { FieldProvenance, FillSourceRecord } from './formFill';
import { ReviewEdit } from './workflow';

/* ------------------------------------------------------------------ */
/* Specs                                                               */
/* ------------------------------------------------------------------ */

/** What a version is written FOR. The core knows nothing beyond this. */
export interface VersionSpec {
  id: string;
  /** 'channel' today; other kinds (audience) are further adapters. */
  kind: string;
  name: string;
  /** Prose handed to the model: what works for this target. */
  guidance: string;
  /** A version is ALWAYS an array of segments; this caps its length. */
  maxSegments: number;
}

export type ChannelFamily = 'social' | 'email' | 'messaging' | 'web';

/** How a channel counts characters. X weights URLs and wide scripts. */
export type ChannelCounting =
  | 'graphemes'
  | 'utf16'
  | 'url-23'
  | 'x-weighted'
  | 'gsm7';

/** A named span with its own budget, e.g. LinkedIn's line before the fold. */
export interface ChannelSlot {
  id: string;
  /** Key under `workflows.channelDrafter.slots.*`. */
  labelKey: string;
  maxChars: number;
  appliesTo: 'first-segment-first-line';
  /** Label drawn on the fold rule under the slot, when the platform has one. */
  foldLabelKey?: string;
}

export interface ChannelProfile extends VersionSpec {
  kind: 'channel';
  family: ChannelFamily;
  /** Characters per segment, under `counting`. */
  segmentLimit: number;
  counting: ChannelCounting;
  slots: ChannelSlot[];
  hashtags: { max: number; placement: 'inline' | 'end' | 'none' };
  /**
   * Whether links are clickable here, and which post of a thread carries
   * them. Links are appended by code, never written by the model.
   */
  links: { allowed: boolean; position: 'first' | 'last' };
  /** Thread numbering convention, when maxSegments > 1. */
  threadNumbering: 'none' | 'n/N';
  /**
   * Images per post and the alt text limit, where the channel has them.
   * Absent = not checked. `maxImages: 0` = the channel carries no images.
   */
  media?: { maxImages: number; altLimit?: number };
  /**
   * Where "Send to Hootsuite" sends this channel's posts: the Hootsuite
   * social profile, as that connector identifies it. Set by an admin; a
   * channel without one cannot be sent when the tool needs a target.
   */
  publishTarget?: string;
}

/* ------------------------------------------------------------------ */
/* Channel rule sets                                                   */
/* ------------------------------------------------------------------ */

/**
 * One team's rules for one platform: HOW they write for it. What the
 * platform IS stays on the platform (`ChannelProfile` facts) and is never
 * copied, so a limit change reaches every set at once. Absent = the
 * platform's own.
 */
export interface ChannelRule {
  enabled: boolean;
  guidance?: string;
  hashtags?: ChannelProfile['hashtags'];
  linkPosition?: 'first' | 'last';
  /** An organisation tone guide written for by default on this channel. */
  defaultVoiceGuideId?: string;
  publishTarget?: string;
}

export interface ChannelSetDefaults {
  channelIds: string[];
  donationUrl?: string;
  articleLink: boolean;
  guideIds: string[];
}

/** The editable part of a set: everything but its identity and stamps. */
export interface ChannelSetData {
  name: string;
  /** English name of the language the guidance is written in; '' = any. */
  language: string;
  description: string;
  /** Keyed by platform id; a platform not listed is not offered. */
  channels: Record<string, ChannelRule>;
  defaults: ChannelSetDefaults;
  /** Tie-break when a user may use several sets equally. */
  isDefault: boolean;
}

/** The reason a user may use a set, most specific first. */
export type ChannelSetGrant = 'user' | 'group' | 'domain' | 'everyone';

/**
 * A set as the drafter sees it: its identity, its defaults and the
 * channels it offers, already merged with the platforms. Served by
 * GET /api/channel-sets.
 */
export interface ChannelSetSummary {
  id: string;
  name: string;
  language: string;
  description: string;
  isDefault: boolean;
  grant: ChannelSetGrant;
  defaults: ChannelSetDefaults;
  /** Default voice per channel id, from the set's rules. */
  defaultVoices: Record<string, string>;
  channels: ChannelProfile[];
}

/* ------------------------------------------------------------------ */
/* Sources and brief                                                   */
/* ------------------------------------------------------------------ */

/**
 * Form-fill's source record, unchanged. `url` is the way back to the
 * original for proof: the page for a `url` source, the item's web address
 * for an `m365` one (the same convention form-fill uses).
 */
export type DraftSource = FillSourceRecord;

export type BriefItemKind =
  | 'quote'
  | 'testimony'
  | 'fact'
  | 'figure'
  | 'context';

/**
 * `verbatim`: the excerpt was found in the source by code.
 * `user-asserted`: the user vouched for it without a source.
 * `unverified`: the model proposed it and no match was found.
 */
export type BriefVerification = 'verbatim' | 'user-asserted' | 'unverified';

export interface BriefItem {
  id: string;
  kind: BriefItemKind;
  text: string;
  /** Quotes/testimony: who said it. Never model-invented. */
  attribution?: { name: string; role?: string };
  provenance: FieldProvenance[];
  verified: BriefVerification;
  /**
   * Present on an item translated from another draft: the words as they were
   * verified, and their language. The proof for a translated quotation is
   * its original plus the source passage; the translation itself is a
   * translation, and is shown as one.
   */
  original?: { text: string; language: string };
  /**
   * The user's include/exclude decision. Editing `text` clears an include,
   * so nothing signed off is ever silently different from what was seen.
   */
  decision?: 'included' | 'excluded';
}

/**
 * A link the versions carry. `article` points at the single web page the
 * draft is based on (promoting a published article or statement);
 * `donation` is the user's own giving page, and its presence is what makes
 * asking for donations the purpose of the posts. Neither is ever assumed.
 */
export type BriefLinkRole = 'article' | 'donation';

export interface BriefLink {
  role: BriefLinkRole;
  label: string;
  url: string;
}

export interface Brief {
  /** Bumps on any accepted change that versions can depend on. */
  rev: number;
  keyMessage: string;
  /** Order is priority: the generator leads with the first that fits. */
  items: BriefItem[];
  callToAction?: string;
  /** Included links only; at most one per role. */
  links: BriefLink[];
  /** English name of the language the versions are written in. */
  language: string;
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

export interface ToneRef {
  kind: 'tone' | 'guide';
  id: string;
}

/**
 * An image attached to one segment. Only a reference and its alt text live
 * in state; the bytes stay in the file store, like every other upload.
 */
export interface MediaAttachment {
  id: string;
  /** Internal '/api/file/{sha}.{ext}' ref from the image upload. */
  ref: string;
  name: string;
  /**
   * What the image shows, for people who cannot see it. Required before a
   * post is final: an empty one is a blocking finding.
   */
  alt: string;
}

export interface Segment {
  id: string;
  text: string;
  /** Brief items this segment draws on, as reported at generation. */
  usedItemIds: string[];
  /** Images this segment carries. Absent = none. */
  media?: MediaAttachment[];
}

/** A suggestion on one segment, in the shared review shape. */
export interface VersionEdit extends ReviewEdit {
  segmentId: string;
  /** The instruction that produced it, shown with the suggestion. */
  instruction?: string;
}

export interface VersionSnapshot {
  at: string;
  reason: 'generated' | 'updated' | 'revised' | 'restored';
  texts: string[];
  /** Per segment, parallel to `texts`. Absent on older snapshots. */
  usedItemIds?: string[][];
  /** The brief digest the texts were written from. */
  briefDigest?: string;
}

/** A named mapping from spec to voice: "one tone can serve many channels". */
export interface VoiceSet {
  id: string;
  name: string;
  /** The kind of spec the ids belong to ('channel'). */
  specKind: string;
  bySpec: Record<string, ToneRef>;
}

export interface Version {
  specId: string;
  /** The voice this version is written in; absent = the spec's own guidance. */
  toneRef?: ToneRef;
  /** Length 1 unless the spec allows more (threads). */
  segments: Segment[];
  /** The brief revision this text was written from. */
  briefRev: number;
  /**
   * Digest of the brief inputs this version actually depends on (its used
   * items, the key message, the call to action). Staleness compares this,
   * not `briefRev`, so an unrelated brief edit does not flag the version.
   */
  briefDigest: string;
  /** Typed by the user; protects from wholesale regeneration. */
  handEdited: boolean;
  /** Model suggestions from a revision; pending until the user decides. */
  edits?: VersionEdit[];
  /** A rewrite waiting for the user's Keep mine / Use new decision. */
  proposed?: {
    segments: Segment[];
    briefRev: number;
    /** Digest of the brief the proposal was written from. */
    briefDigest?: string;
    reason: string;
  };
  /**
   * The user's "this text is final" tick, with the text it was given on.
   * Whether it still HOLDS is derived (approvalStatus), never stored: any
   * change to the segments, typed or generated, makes it lapse.
   */
  approval?: { at: string; texts: string[]; media?: string[] };
  /**
   * Instructions already offered to this version's voice ("Always do this
   * here?"), whether added or declined, so each is offered once.
   */
  taught?: string[];
  /**
   * Set when the post was sent to Hootsuite. What happens to it there (a
   * draft, a scheduled post) is Hootsuite's; a later change here shows
   * "Changed since sent", since the two no longer match.
   */
  sent?: { at: string; texts: string[]; media?: string[] };
  /** Set by Copy; a later change shows "Changed since copied". */
  copied?: { at: string; texts: string[]; media?: string[] };
  history: VersionSnapshot[];
}

/** Compare arrangement, per conversation. */
export interface DraftLayout {
  hidden: string[];
  pinned: string[];
}

/** Core state. Every drafter workflow's state is this plus its own `kind`. */
export interface DraftSetState {
  updatedAt: string;
  sources: DraftSource[];
  brief: Brief;
  /**
   * The rule set the specs are resolved in. Absent on a draft made before
   * sets existed, which means the default set.
   */
  setId?: string;
  voiceSetId?: string;
  guideIds: string[];
  /** Specs in play, in the user's order. */
  specIds: string[];
  layout: DraftLayout;
  versions: Record<string, Version>;
  /** Base36 counter for item and segment ids. */
  nextId: number;
}

export interface ChannelDrafterWorkflowState extends DraftSetState {
  kind: 'channel-drafter';
}

/* ------------------------------------------------------------------ */
/* Derived, never stored                                               */
/* ------------------------------------------------------------------ */

export type ApprovalStatus = 'none' | 'approved' | 'changed';

/** A span of a segment that traces to the brief, or fails to. */
export interface GroundingMark {
  segmentId: string;
  start: number;
  end: number;
  kind: 'quote' | 'number';
  /** The brief item it matched; absent = matches nothing (a finding). */
  itemId?: string;
}

/** Worst-first column status; the UI shows the first that applies. */
export type VersionStatus =
  | 'empty'
  | 'to-fix'
  | 'suggestions'
  | 'proposed'
  | 'brief-changed'
  | 'approval-changed'
  | 'ready'
  | 'approved';

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const DRAFTER_LIMITS = {
  MAX_SOURCES: 8,
  MAX_BRIEF_ITEMS: 40,
  MAX_ITEM_CHARS: 1_200,
  MAX_SPECS: 8,
  MAX_SEGMENT_CHARS: 6_000,
  MAX_HISTORY: 10,
  MAX_MEDIA_PER_SEGMENT: 10,
  MAX_ALT_CHARS: 2_000,
  /** Characters of source shown either side of a matched excerpt. */
  PASSAGE_CONTEXT_CHARS: 300,
} as const;

/* ------------------------------------------------------------------ */
/* API contracts (stateless routes under /api/workflows/drafter)       */
/* ------------------------------------------------------------------ */

export interface DrafterSourceInput {
  record: DraftSource;
  text: string;
}

export interface ExtractRequest {
  specKind: string;
  sources: DrafterSourceInput[];
  /** Items already in the brief, so the model does not repeat them. */
  existing: Array<{ kind: BriefItemKind; text: string }>;
  language?: string;
  modelId?: string;
  conversationId?: string;
}

/** An extracted item before the client assigns ids. */
export type ExtractedItem = Omit<BriefItem, 'id' | 'decision'>;

export interface ExtractResponse {
  keyMessage: string;
  callToAction?: string;
  language: string;
  items: ExtractedItem[];
}

export interface GenerateToneInput {
  name: string;
  voiceRules: string;
  examples?: string;
}

export interface GenerateRequest {
  specKind: string;
  /** The rule set the spec ids belong to; absent = the default set. */
  setId?: string;
  /** Ids of built-in specs; the server resolves them, never trusts a body. */
  specIds: string[];
  brief: {
    keyMessage: string;
    callToAction?: string;
    links: BriefLink[];
    language: string;
    /** INCLUDED items only, in priority order. */
    items: Array<
      Pick<BriefItem, 'id' | 'kind' | 'text' | 'attribution' | 'verified'>
    >;
  };
  /** The user's own tone per spec id, sent inline. */
  tones: Record<string, GenerateToneInput>;
  /**
   * An organisation tone guide per spec id. Resolved server-side, so access
   * rules apply; a spec with neither writes from its guidance alone.
   */
  toneGuideIds?: Record<string, string>;
  /** For "Update": the current text per spec, to be revised not replaced. */
  current?: Record<string, string[]>;
  modelId?: string;
  conversationId?: string;
}

/** Who a revision instruction is addressed to: the rail's "To:" line. */
export interface RevisionScope {
  /** Spec ids; empty = every spec in play. */
  specIds: string[];
  /** Narrows a single-spec scope to one segment. */
  segmentId?: string;
}

export interface ReviseRequest {
  specKind: string;
  /** The rule set the spec ids belong to; absent = the default set. */
  setId?: string;
  instruction: string;
  targets: Array<{
    specId: string;
    segments: Array<{ id: string; text: string }>;
    /** When set, only this segment may be changed. */
    segmentId?: string;
  }>;
  /**
   * 'tighten' = make what is over its limit fit. The instruction is then
   * written by the server from its own measurement, and `instruction` is
   * ignored.
   */
  mode?: 'instruct' | 'tighten';
  brief: GenerateRequest['brief'];
  tones: Record<string, GenerateToneInput>;
  toneGuideIds?: Record<string, string>;
  modelId?: string;
  conversationId?: string;
}

export interface ProposedEdit {
  segmentId: string;
  before: string;
  after: string;
  reason: string;
  /**
   * What the suggestion answers to: a built-in assessment criterion, a
   * `guide:<id>`, or absent for a revision the user asked for.
   */
  criterion?: string;
}

/** Built-in criteria every assessment applies, guides or not. */
export const DRAFTER_CRITERIA = ['faithful', 'human-first', 'voice'] as const;
export type DrafterCriterion = (typeof DRAFTER_CRITERIA)[number];

export interface AssessRequest {
  specKind: string;
  /** The rule set the spec ids belong to; absent = the default set. */
  setId?: string;
  targets: ReviseRequest['targets'];
  brief: GenerateRequest['brief'];
  tones: Record<string, GenerateToneInput>;
  toneGuideIds?: Record<string, string>;
  /** Organisation style / compliance guides, at most three. */
  guideIds: string[];
  modelId?: string;
  conversationId?: string;
}

export interface ReviseResponse {
  results: Array<{
    specId: string;
    edits: ProposedEdit[];
    /**
     * Tighten only: characters still over with every edit accepted. 0 or
     * absent = accepting them all makes it fit.
     */
    stillOver?: number;
    /** Set when this spec's call failed; the others still return. */
    error?: string;
  }>;
}

export interface TranslateBriefRequest {
  specKind: string;
  /** English names, e.g. 'English' → 'French'. */
  sourceLanguage: string;
  targetLanguage: string;
  keyMessage: string;
  callToAction?: string;
  items: Array<{
    id: string;
    kind: BriefItemKind;
    text: string;
    role?: string;
  }>;
  modelId?: string;
  conversationId?: string;
}

export interface TranslateBriefResponse {
  keyMessage: string;
  callToAction?: string;
  items: Array<{
    id: string;
    text: string;
    role?: string;
    /** False when a number in the translation is not in the original. */
    numbersPreserved: boolean;
  }>;
}

export interface GeneratedVersion {
  specId: string;
  segments: Array<{ text: string; usedItemIds: string[] }>;
  /** Set when this spec's call failed; the others still return. */
  error?: string;
}

export interface GenerateResponse {
  versions: GeneratedVersion[];
}
