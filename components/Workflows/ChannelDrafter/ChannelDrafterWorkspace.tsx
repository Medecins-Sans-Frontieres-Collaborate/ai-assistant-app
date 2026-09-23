'use client';

import {
  IconChecks,
  IconClipboardCheck,
  IconCopy,
  IconDotsVertical,
  IconEye,
  IconEyeCheck,
  IconEyeOff,
  IconFileDownload,
  IconLanguage,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessage2,
  IconMicrophone,
  IconPlus,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useAvailableGuides } from '@/client/hooks/settings/useAvailableGuides';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';
import { useChannelSets } from '@/client/hooks/workflows/useChannelSets';
import { useDraftSet } from '@/client/hooks/workflows/useDraftSet';

import { downloadDriveItem } from '@/client/services/m365/m365Client';
import { ensureFreshOauthToken } from '@/client/services/mcp/mcpOauth';
import {
  fetchUrlContent,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';
import { uploadPhotos } from '@/client/services/workflows/data/photoExtraction';
import {
  assessVersions,
  extractBrief,
  generateVersions,
  getPublishAccess,
  reviseVersions,
  sendPost,
  suggestAltText,
  translateBrief,
} from '@/client/services/workflows/drafter/drafterApi';
import { setRailContext } from '@/client/services/workflows/drafter/drafterRailChat';
import { rememberSpecNames } from '@/client/services/workflows/drafter/specNames';
import {
  currentVoices,
  sameVoices,
  voiceInputsFor,
} from '@/client/services/workflows/drafter/voiceInputs';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { downloadBlob } from '@/client/services/workflows/form/formApi';
import {
  forgetSourceText,
  getSourceText,
  rememberPageText,
  rememberSourceText,
} from '@/client/services/workflows/form/sourceText';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';

import { createWorkflowConversation } from '@/lib/utils/app/conversationInit';
import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import {
  DEFAULT_CHANNEL_SET_ID,
  pickChannelSet,
  publishRuleName,
} from '@/lib/utils/shared/drafter/channels/channelSets';
import {
  addExtractedItems,
  addItemFromSelection,
  addOwnItem,
  briefLink,
  editItemText,
  includeAllVerified,
  includedItems,
  moveItem,
  removeItem,
  resolveItemFromSelection,
  sameHttpUrl,
  setBriefLink,
  setCallToAction,
  setItemDecision,
  setKeyMessage,
  unescapeMarkdownInBrief,
  vouchForItem,
} from '@/lib/utils/shared/drafter/core/brief';
import {
  groundVersion,
  specsUsingItem,
} from '@/lib/utils/shared/drafter/core/grounding';
import {
  addMedia,
  hasMedia,
  removeMedia,
  setMediaAlt,
} from '@/lib/utils/shared/drafter/core/media';
import { publishBlockers } from '@/lib/utils/shared/drafter/core/publishing';
import { buildReviewPack } from '@/lib/utils/shared/drafter/core/reviewPack';
import {
  acceptAllEdits,
  acceptEdit,
  discardPendingEdits,
  landEdits,
  pendingEdits,
  rejectEdit,
} from '@/lib/utils/shared/drafter/core/revisions';
import {
  mergeWithPrevious,
  splitSegment,
} from '@/lib/utils/shared/drafter/core/segments';
import {
  appendVoiceRule,
  markTaught,
  teachableInstruction,
} from '@/lib/utils/shared/drafter/core/teaching';
import { translatedDraftState } from '@/lib/utils/shared/drafter/core/translation';
import { isVerbatim } from '@/lib/utils/shared/drafter/core/verify';
import {
  useProposed as acceptProposed,
  applyGenerated,
  approveVersion,
  clearApproval,
  editSegmentText,
  emptyVersion,
  hasText,
  isReadyToApprove,
  isStale,
  keepMine,
  markCopied,
  markSent,
  restoreSnapshot,
  segmentTexts,
  setSegments,
  versionStatuses,
} from '@/lib/utils/shared/drafter/core/versions';
import { blockingCount } from '@/lib/utils/shared/review/deterministicChecks';
import {
  MAX_GUIDES_PER_ASSESSMENT,
  guideCriterionId,
  guideIdFromCriterionId,
} from '@/lib/utils/shared/review/guideCriteria';
import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
} from '@/lib/utils/shared/translation/languages';

import {
  ChannelDrafterWorkflowState,
  ChannelProfile,
  ChannelSetSummary,
  DRAFTER_LIMITS,
  DraftSource,
  ToneRef,
  Version,
  VersionStatus,
} from '@/types/drafter';
import { M365DriveEntry } from '@/types/m365';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';
import { LanguagePicker } from '@/components/UI/LanguagePicker';
import { BriefPane } from '@/components/Workflows/Shared/Drafter/BriefPane';
import {
  Popover,
  iconButton,
  menuItem,
} from '@/components/Workflows/Shared/Drafter/Popover';
import { SourceViewer } from '@/components/Workflows/Shared/Drafter/SourceViewer';
import {
  SendBlocker,
  VersionColumn,
  VoiceOption,
} from '@/components/Workflows/Shared/Drafter/VersionColumn';
import { shortSpecName } from '@/components/Workflows/Shared/Drafter/specNames';
import { GuidePicker } from '@/components/Workflows/Shared/Review/GuidePicker';
import { WorkflowWorkspaceProps } from '@/components/Workflows/registry';

import { SourcesStrip } from './SourcesStrip';
import { channelAdapterUi } from './channelAdapterUi';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import {
  EVERY_SPEC,
  useWorkflowRailStore,
} from '@/client/stores/workflowRailStore';
import { HOOTSUITE_PUBLISHING } from '@/config/publishing';

const SPEC_KIND = 'channel';
const KIND = 'channel-drafter' as const;
type State = ChannelDrafterWorkflowState;

const toolbarButton =
  'inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
/** The column's status as a dot on its pill in the bar. */
const STATUS_DOT: Record<VersionStatus, string> = {
  empty: 'bg-gray-300 dark:bg-gray-600',
  'to-fix': 'bg-amber-500',
  suggestions: 'bg-blue-500',
  proposed: 'bg-blue-500',
  'brief-changed': 'bg-amber-500',
  'approval-changed': 'bg-amber-500',
  ready: 'bg-gray-500 dark:bg-gray-400',
  approved: 'bg-green-600',
};

/** The channel list while the user has no set at all. */
const NO_CHANNELS: ChannelProfile[] = [];

/**
 * The set's default voice for each channel that has none yet: an
 * organisation tone guide, set when the channel comes into play. Only a
 * version with nothing in it yet (no text, no history) takes one, so a voice
 * the user chose — including "no voice" on a channel they removed and put
 * back — is never touched. A guide this user cannot read is not applied
 * either: the server would refuse it on every write.
 */
function withDefaultVoices(
  versions: Record<string, Version>,
  specIds: ReadonlyArray<string>,
  defaultVoices: Record<string, string>,
  readableGuideIds: ReadonlySet<string>,
): Record<string, Version> {
  let next = versions;
  for (const specId of specIds) {
    const guideId = defaultVoices[specId];
    const existing = next[specId];
    if (!guideId || !readableGuideIds.has(guideId)) continue;
    if (
      existing &&
      (existing.toneRef ||
        existing.segments.length > 0 ||
        existing.history.length > 0)
    ) {
      continue;
    }
    next = {
      ...next,
      [specId]: {
        ...(next[specId] ?? emptyVersion(specId)),
        toneRef: { kind: 'guide', id: guideId },
      },
    };
  }
  return next;
}

/** The channels a new draft in this set starts with, within the set's offer. */
function startingChannels(
  set: ChannelSetSummary,
  remembered: string[] | undefined,
): string[] {
  const wanted = remembered ?? set.defaults.channelIds;
  return wanted
    .filter((id) => set.channels.some((channel) => channel.id === id))
    .slice(0, DRAFTER_LIMITS.MAX_SPECS);
}

function liveState(conversationId: string): State | undefined {
  const state = useConversationStore
    .getState()
    .conversations.find((c) => c.id === conversationId)?.workflowState;
  return state?.kind === KIND ? state : undefined;
}

/**
 * The channel drafter: a thin workspace that mounts the shared drafter core
 * (brief pane, version columns) with the channel adapter. Sources on top,
 * the brief on the inline-start side, one column per channel beside it.
 * See docs/CHANNEL_DRAFTER_DESIGN.md §9.
 */
export function ChannelDrafterWorkspace({
  conversationId,
}: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows.drafter');
  const tForm = useTranslations('workflows.form');
  const tKind = useTranslations(channelAdapterUi.namespace);
  const [tightening, setTightening] = useState<{
    specId: string;
    segmentId: string;
  } | null>(null);
  const { state, modelId, setState, mintIds } = useDraftSet<State>(
    conversationId,
    KIND,
  );
  const adapter = getSpecAdapter(SPEC_KIND);
  // The rule sets this user may draft in; one virtual default until (and
  // unless) the server's list arrives. The draft works INSIDE one of them.
  const { sets, suggestedSetId, isAuthoritative, isSettled, noSets } =
    useChannelSets();
  const lastChannelSetId = useSettingsStore((s) => s.lastChannelSetId);
  const setLastChannelSetId = useSettingsStore((s) => s.setLastChannelSetId);
  // The draft's own set; before it has one, the set the user lands in: the
  // one they used last if they still may, else the server's suggestion.
  // Undefined only when the server says this user has no set at all.
  const namedSet = state?.setId
    ? sets.find((set) => set.id === state.setId)
    : undefined;
  const activeSet: ChannelSetSummary | undefined =
    namedSet ??
    pickChannelSet(
      sets,
      sets.some((set) => set.id === lastChannelSetId)
        ? lastChannelSetId
        : suggestedSetId,
    ) ??
    undefined;
  // THE set id this workspace acts in: on the chip, in every request (the
  // rail's too, through setRailContext), as the key for remembered
  // channels. The draft's own once seeded; before that the set the user
  // lands in, which is the virtual default while the list loads or has
  // failed, so what is shown and what is sent never disagree.
  const effectiveSetId =
    state?.setId ?? activeSet?.id ?? DEFAULT_CHANNEL_SET_ID;
  // The draft names a set the user no longer has: its text is kept and the
  // draft is paused until it is moved to a set they have (the banner offers
  // the one they would land in). Only judged once the server's list is here.
  const setUnavailable = isAuthoritative && !!state?.setId && !namedSet;
  const channels = activeSet?.channels ?? NO_CHANNELS;
  useEffect(() => {
    rememberSpecNames(channels);
  }, [channels]);

  const [busy, setBusy] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [writing, setWriting] = useState<string[]>([]);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [tracedItemId, setTracedItemId] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(true);
  /** The source viewer, shown in place of the brief list while open. */
  const [viewer, setViewer] = useState<{
    sourceId: string;
    itemId?: string;
  } | null>(null);
  /** Focus mode: one channel given the whole area. Not persisted. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [m365PickerOpen, setM365PickerOpen] = useState(false);
  const headerRefs = useRef<Record<string, HTMLElement | null>>({});

  const { filesEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const m365Available = filesEnabled && m365Connected;
  const setLastChannelIds = useSettingsStore((s) => s.setLastChannelIds);
  const rememberedDonationUrl = useSettingsStore((s) => s.donationUrl);
  const setDonationUrl = useSettingsStore((s) => s.setDonationUrl);

  // Voices: the user's own tones, then the organisation's tone guides.
  const userTones = useSettingsStore((s) => s.tones);
  const voiceSets = useSettingsStore((s) => s.voiceSets);
  const saveVoiceSet = useSettingsStore((s) => s.saveVoiceSet);
  const addTone = useSettingsStore((s) => s.addTone);
  const updateTone = useSettingsStore((s) => s.updateTone);
  const { guides, isLoadingGuides } = useAvailableGuides();
  const voices = useMemo<VoiceOption[]>(
    () => [
      ...userTones.map((tone) => ({
        ref: { kind: 'tone' as const, id: tone.id },
        name: tone.name,
        shared: false,
      })),
      ...guides
        .filter((guide) => guide.kind === 'tone')
        .map((guide) => ({
          ref: { kind: 'guide' as const, id: guide.id },
          name: guide.name,
          shared: true,
        })),
    ],
    [userTones, guides],
  );
  // The organisation tone guides this user may read. A set's default voice
  // outside this list is never applied, and a version's voice outside it is
  // not sent: the server would answer VOICE_UNAVAILABLE on every write.
  const readableGuideIds = useMemo(
    () =>
      new Set(guides.filter((guide) => guide.kind === 'tone').map((g) => g.id)),
    [guides],
  );

  // Seeding. A draft with no set yet is fixed to the set the user lands in
  // and starts with the channels they last used there (else the set's own
  // defaults) and the set's Check guides, so there is no set- or channel-
  // picking step. It waits for the server's sets (and the guides, for the
  // default voices), so it is not fixed to the virtual default while the
  // real list is still on its way; and only an AUTHORITATIVE list may fix it
  // at all: after a failed request the channels are seeded for the session
  // but nothing the real list might contradict is written, and the effect
  // runs again when it arrives. A draft from before sets existed (text, no
  // set) is fixed to the default.
  const channelsSeeded = useRef(false);
  const setFixed = useRef(false);
  const briefRepaired = useRef(false);
  useEffect(() => {
    if (!state || setFixed.current) return;
    if (!briefRepaired.current) {
      briefRepaired.current = true;
      // A draft saved while pages were still Markdown carries "\[province\]"
      // in its items; repaired once, on load, so nothing is quoted that way.
      if (unescapeMarkdownInBrief(state.brief) !== state.brief) {
        setState((prev) => ({
          ...prev,
          brief: unescapeMarkdownInBrief(prev.brief),
        }));
      }
    }
    if (!state.setId && (!isSettled || isLoadingGuides)) return;
    // Nowhere to draft: the workspace says so rather than seeding a set the
    // server would refuse.
    if (noSets || !activeSet) return;
    // Seedable: nothing written yet under any rules. Sources alone do not
    // make a draft "old" — one added while the list loaded must not leave
    // it fixed to the default with zero channels.
    const seedable =
      !state.setId && !Object.values(state.versions).some(hasText);
    const fixedSetId =
      state.setId ?? (seedable ? activeSet.id : DEFAULT_CHANNEL_SET_ID);
    const set = sets.find((entry) => entry.id === fixedSetId) ?? activeSet;
    const seedChannels = !channelsSeeded.current;
    const remembered =
      useSettingsStore.getState().lastChannelIdsBySet[fixedSetId];
    const seededIds = seedChannels ? startingChannels(set, remembered) : [];
    // A zero-channel seed off the virtual default (its own defaults are
    // empty) leaves the door open for the real list to seed properly.
    channelsSeeded.current = isAuthoritative || seededIds.length > 0;
    if (isAuthoritative) {
      setFixed.current = true;
      if (seedable) setLastChannelSetId(fixedSetId);
    }
    setState((prev) => {
      const withSet =
        isAuthoritative && prev.setId !== fixedSetId
          ? { ...prev, setId: fixedSetId }
          : prev;
      if (!seedChannels || prev.specIds.length > 0) return withSet;
      return {
        ...withSet,
        specIds: seededIds,
        guideIds:
          prev.guideIds.length > 0 ? prev.guideIds : set.defaults.guideIds,
        versions: withDefaultVoices(
          prev.versions,
          seededIds,
          set.defaultVoices,
          readableGuideIds,
        ),
      };
    });
  }, [
    state,
    setState,
    isSettled,
    isAuthoritative,
    isLoadingGuides,
    noSets,
    sets,
    activeSet,
    setLastChannelSetId,
    readableGuideIds,
  ]);

  const [namingVoiceSet, setNamingVoiceSet] = useState<string | null>(null);
  // Drafting in another language opens a NEW draft from a translated brief.
  const { addConversation } = useConversations();
  const { defaultModelId, models, temperature, systemPrompt } = useSettings();
  const languageButtonRef = useRef<HTMLButtonElement>(null);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  /** A one-line note after a set change; cleared by the next one. */
  const [notice, setNotice] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const languageOptions = useMemo<LanguageOption[]>(
    () =>
      sortLanguageOptionsByLabel(
        TRANSLATION_LANGUAGES.map<LanguageOption>((lang) => ({
          code: lang.id,
          label: lang.name,
          sublabel: lang.autonym !== lang.name ? lang.autonym : undefined,
        })),
      ),
    [],
  );
  const [checkOpen, setCheckOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  // Sending to Hootsuite. The server decides who may and whether the tool
  // is configured at all; until it says so there is no button anywhere.
  const publishAccess = useQuery({
    queryKey: ['channel-drafter-publish-access'],
    queryFn: getPublishAccess,
    staleTime: 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
  });
  const hootsuite = useSettingsStore((s) =>
    s.mcpServers.find(
      (server) => server.catalogKey === HOOTSUITE_PUBLISHING.catalogKey,
    ),
  );
  const [sendingId, setSendingId] = useState<string | null>(null);
  /** The image being described, or the segment being uploaded to. */
  const [mediaBusyId, setMediaBusyId] = useState<string | null>(null);
  /** Which columns show their post as the channel will roughly show it. */
  const [previewing, setPreviewing] = useState<Record<string, boolean>>({});
  /** Names of the guides the last check applied, for labelling suggestions. */
  const [criterionNames, setCriterionNames] = useState<Record<string, string>>(
    {},
  );
  const criterionGuides = useMemo(
    () =>
      guides.filter(
        (guide) => guide.kind === 'style' || guide.kind === 'compliance',
      ),
    [guides],
  );

  const setScope = useWorkflowRailStore((s) => s.setScope);
  const requestRailOpen = useWorkflowRailStore((s) => s.requestOpen);

  const brief = state?.brief;
  const specsInPlay = useMemo(
    () =>
      (state?.specIds ?? [])
        .map((id) => channels.find((profile) => profile.id === id))
        .filter((profile): profile is ChannelProfile => !!profile),
    [state?.specIds, channels],
  );
  // Focus only counts while the channel is still in play: a set change can
  // drop the focused channel, and Check or the rail must not address it.
  const focusedId =
    focusId && specsInPlay.some((profile) => profile.id === focusId)
      ? focusId
      : null;

  // Why writing, checking, tightening, sending and revising are paused, if
  // they are: the draft's set is gone (its name is unknown, so its id is
  // named), or the user has no set at all. The banner says the same.
  const blockedReason = noSets
    ? t('noSetsAvailable')
    : setUnavailable && state?.setId
      ? t('setLost', { set: state.setId })
      : null;

  // The "To:" line follows where the user is: every channel in Compare, the
  // one on screen in Focus. It is only a default; the rail lets them change
  // it, and a door (below) sets it explicitly.
  useEffect(() => {
    setScope(conversationId, focusedId ? { specIds: [focusedId] } : EVERY_SPEC);
  }, [conversationId, focusedId, setScope]);
  // What the rail's send module cannot derive itself: the set to revise in
  // (the same one every request here uses) and whether revising is paused.
  useEffect(() => {
    setRailContext(conversationId, { setId: effectiveSetId, blockedReason });
    return () => setRailContext(conversationId, null);
  }, [conversationId, effectiveSetId, blockedReason]);

  /** Opens the rail addressed to everything, one channel, or one post. */
  const revise = (specId?: string, segmentId?: string) => {
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    setScope(
      conversationId,
      specId ? { specIds: [specId], segmentId } : EVERY_SPEC,
    );
    requestRailOpen();
  };

  const specIdsKey = (state?.specIds ?? []).join(',');
  useEffect(() => {
    // Remembered only under a set the user really has: a vanished set must
    // not gain a row, nor the virtual default while the real list is unknown.
    if (!channelsSeeded.current || !specIdsKey || !isAuthoritative) return;
    if (!sets.some((set) => set.id === effectiveSetId)) return;
    setLastChannelIds(effectiveSetId, specIdsKey.split(','));
  }, [specIdsKey, effectiveSetId, setLastChannelIds, isAuthoritative, sets]);

  /**
   * The voices as they are sent. A guide this user cannot read is left out
   * (the channel writes from its own guidance) rather than refused by the
   * server; while the guide list is still loading nothing is judged.
   */
  const sendableVoices = useCallback(
    (current: State, specIds: string[]) => {
      const inputs = voiceInputsFor(current, specIds);
      if (isLoadingGuides) return inputs;
      for (const [specId, guideId] of Object.entries(inputs.toneGuideIds)) {
        if (!readableGuideIds.has(guideId)) delete inputs.toneGuideIds[specId];
      }
      return inputs;
    },
    [isLoadingGuides, readableGuideIds],
  );

  /** Everything derived about each version, recomputed on any change. */
  const derived = useMemo(() => {
    const result: Record<
      string,
      {
        findings: ReturnType<typeof checkVersion>;
        marks: ReturnType<typeof groundVersion>;
        statuses: ReturnType<typeof versionStatuses>;
      }
    > = {};
    if (!state || !adapter) return result;
    for (const profile of specsInPlay) {
      const version = state.versions[profile.id];
      const segments = version?.segments ?? [];
      const findings = hasText(version)
        ? checkVersion(adapter, profile, segments, state.brief)
        : [];
      result[profile.id] = {
        findings,
        marks: groundVersion(segments, state.brief),
        statuses: versionStatuses(version, {
          brief: state.brief,
          blocking: blockingCount(findings),
        }),
      };
    }
    return result;
  }, [state, adapter, specsInPlay]);

  const usedIn = useMemo(() => {
    const result: Record<string, string[]> = {};
    if (!state) return result;
    for (const item of state.brief.items) {
      result[item.id] = specsUsingItem(item.id, state.versions, state.brief)
        .map((id) => channels.find((profile) => profile.id === id)?.name)
        .filter((name): name is string => !!name);
    }
    return result;
  }, [state, channels]);

  const updateVersion = useCallback(
    (specId: string, updater: (version: Version) => Version) => {
      setState((prev) => {
        const current = prev.versions[specId] ?? emptyVersion(specId);
        const next = updater(current);
        return next === current
          ? prev
          : { ...prev, versions: { ...prev.versions, [specId]: next } };
      });
    },
    [setState],
  );

  /* ---------------- sources and extraction ---------------- */

  const runExtraction = useCallback(
    async (source: DraftSource, text: string) => {
      if (!text.trim()) return;
      setExtracting(true);
      setError(null);
      try {
        const current = liveState(conversationId);
        const response = await extractBrief({
          specKind: SPEC_KIND,
          sources: [{ record: source, text }],
          existing: (current?.brief.items ?? []).map((item) => ({
            kind: item.kind,
            text: item.text,
          })),
          modelId,
          conversationId,
        });
        setState((prev) => {
          const { ids, next } = mintIds(prev, response.items.length);
          let nextBrief = addExtractedItems(
            next.brief,
            response.items,
            ids.map((id) => `i${id}`),
          );
          // The first source sets the frame; later ones never overwrite
          // what the user may already have edited.
          if (!nextBrief.keyMessage && response.keyMessage) {
            nextBrief = setKeyMessage(nextBrief, response.keyMessage);
          }
          if (!nextBrief.callToAction && response.callToAction) {
            nextBrief = setCallToAction(nextBrief, response.callToAction);
          }
          if (!nextBrief.language) {
            nextBrief = { ...nextBrief, language: response.language };
          }
          return { ...next, brief: nextBrief };
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('extractFailed'));
      } finally {
        setExtracting(false);
      }
    },
    [conversationId, modelId, mintIds, setState, t],
  );

  const addSource = useCallback(
    (source: DraftSource) => {
      setState((prev) =>
        prev.sources.length >= DRAFTER_LIMITS.MAX_SOURCES
          ? prev
          : { ...prev, sources: [...prev.sources, source] },
      );
    },
    [setState],
  );

  const handleAddFile = async (file: File) => {
    setError(null);
    setBusy(tForm('uploading'));
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(tForm('uploadFailed'));
      const source: DraftSource = {
        id: crypto.randomUUID(),
        kind: 'file',
        name: file.name,
        fileId: extracted.url || undefined,
        chars: extracted.text.length,
        addedAt: new Date().toISOString(),
      };
      rememberSourceText(source.id, extracted.text);
      addSource(source);
      nameWorkflowConversation(conversationId, {
        label: file.name,
        workflow: 'Channel drafter',
      });
      setBusy(null);
      await runExtraction(source, extracted.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : tForm('uploadFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleAddUrl = async (url: string) => {
    setError(null);
    setBusy(tForm('uploading'));
    try {
      const result = await fetchUrlContent(url, { modelId });
      const id = crypto.randomUUID();
      const addedAt = new Date().toISOString();
      if (!result.ok) {
        // Kept, marked: a failed fetch must stay visible, not vanish.
        addSource({
          id,
          kind: 'url',
          name: url,
          url,
          chars: 0,
          addedAt,
          error: urlErrorKey(result.code),
        });
        return;
      }
      const source: DraftSource = {
        id,
        kind: 'url',
        name: result.page.title || result.page.resolvedUrl,
        url: result.page.resolvedUrl,
        chars: result.page.text.length,
        addedAt,
      };
      const prose = rememberPageText(id, result.page.text);
      addSource(source);
      // The set's default: a draft resting on one web page links to it
      // unless the team's rules say not to. The brief pane's tick undoes it.
      if (activeSet?.defaults.articleLink) {
        setState((prev) => {
          const pages = prev.sources.filter(
            (entry) => entry.kind === 'url' && !entry.error && !!entry.url,
          );
          const only = pages.length === 1 && pages[0].id === id;
          return only && !briefLink(prev.brief, 'article')
            ? {
                ...prev,
                brief: setBriefLink(prev.brief, 'article', {
                  label: source.name,
                  url: result.page.resolvedUrl,
                }),
              }
            : prev;
        });
      }
      nameWorkflowConversation(conversationId, {
        label: source.name,
        workflow: 'Channel drafter',
      });
      setBusy(null);
      await runExtraction(source, prose);
    } finally {
      setBusy(null);
    }
  };

  const handleAddNote = async (text: string) => {
    const source: DraftSource = {
      id: crypto.randomUUID(),
      kind: 'note',
      name: text.slice(0, 60),
      chars: text.length,
      addedAt: new Date().toISOString(),
      // Notes have no re-fetch path, so the text lives in state (capped).
      text: text.slice(0, 16_000),
    };
    rememberSourceText(source.id, text);
    addSource(source);
    await runExtraction(source, text);
  };

  const handleM365Pick = async (entry: M365DriveEntry) => {
    setM365PickerOpen(false);
    setError(null);
    setBusy(tForm('uploading'));
    try {
      const { blob, name, webUrl } = await downloadDriveItem(
        entry.driveId,
        entry.itemId,
      );
      const file = new File([blob], name || entry.name, {
        type: blob.type || entry.mimeType || 'application/octet-stream',
      });
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(tForm('uploadFailed'));
      const source: DraftSource = {
        id: crypto.randomUUID(),
        kind: 'm365',
        name: name || entry.name,
        fileId: extracted.url || undefined,
        // The item's web address: where "Open source" goes for this kind.
        url: webUrl ?? entry.webUrl,
        chars: extracted.text.length,
        addedAt: new Date().toISOString(),
      };
      rememberSourceText(source.id, extracted.text);
      addSource(source);
      nameWorkflowConversation(conversationId, {
        label: source.name,
        workflow: 'Channel drafter',
      });
      setBusy(null);
      await runExtraction(source, extracted.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : tForm('uploadFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveSource = (sourceId: string) => {
    if (viewer?.sourceId === sourceId) setViewer(null);
    forgetSourceText(sourceId);
    setState((prev) => {
      const removed = prev.sources.find((source) => source.id === sourceId);
      // A link to a page that is no longer a source would promote something
      // the posts are no longer based on, so it leaves with the source.
      const brief =
        removed?.url &&
        sameHttpUrl(briefLink(prev.brief, 'article')?.url ?? '', removed.url)
          ? setBriefLink(prev.brief, 'article', null)
          : prev.brief;
      return {
        ...prev,
        brief,
        sources: prev.sources.filter((source) => source.id !== sourceId),
      };
    });
  };

  /* ---------------- brief ---------------- */

  const setBrief = useCallback(
    (updater: (brief: State['brief']) => State['brief']) => {
      setState((prev) => {
        const next = updater(prev.brief);
        return next === prev.brief ? prev : { ...prev, brief: next };
      });
    },
    [setState],
  );

  /** Re-checks the edited words against the item's own source. */
  const handleEditItem = async (itemId: string, text: string) => {
    const current = liveState(conversationId);
    const item = current?.brief.items.find((entry) => entry.id === itemId);
    const source = current?.sources.find(
      (entry) => entry.id === item?.provenance[0]?.sourceId,
    );
    const sourceText = source ? await getSourceText(source, []) : '';
    const spoken = item?.kind === 'quote' || item?.kind === 'testimony';
    const verified =
      item?.verified === 'user-asserted'
        ? 'user-asserted'
        : spoken
          ? sourceText && isVerbatim(sourceText, text)
            ? 'verbatim'
            : 'unverified'
          : (item?.verified ?? 'unverified');
    setBrief((prev) => editItemText(prev, itemId, text, verified));
  };

  /* ---------------- writing ---------------- */

  const write = useCallback(
    async (specIds: string[]) => {
      const current = liveState(conversationId);
      if (!current || specIds.length === 0) return;
      if (blockedReason) {
        setError(blockedReason);
        return;
      }
      setError(null);
      setWriting(specIds);
      setFailed((prev) => {
        const next = { ...prev };
        for (const id of specIds) delete next[id];
        return next;
      });
      try {
        const currentTexts: Record<string, string[]> = {};
        for (const id of specIds) {
          const version = current.versions[id];
          if (hasText(version)) currentTexts[id] = segmentTexts(version);
        }
        const response = await generateVersions({
          specKind: SPEC_KIND,
          setId: current.setId ?? effectiveSetId,
          specIds,
          brief: {
            keyMessage: current.brief.keyMessage,
            callToAction: current.brief.callToAction,
            links: current.brief.links,
            language: current.brief.language || 'English',
            items: includedItems(current.brief).map((item) => ({
              id: item.id,
              kind: item.kind,
              text: item.text,
              attribution: item.attribution,
              verified: item.verified,
            })),
          },
          ...sendableVoices(current, specIds),
          current: currentTexts,
          modelId,
          conversationId,
        });
        const failures: Record<string, string> = {};
        setState((prev) => {
          let next = prev;
          const versions = { ...prev.versions };
          for (const generated of response.versions) {
            if (generated.error || generated.segments.length === 0) {
              failures[generated.specId] = generated.error ?? 'EMPTY';
              continue;
            }
            const minted = mintIds(next, generated.segments.length);
            next = minted.next;
            versions[generated.specId] = applyGenerated(
              versions[generated.specId],
              generated,
              // The brief that was SENT: an edit made while this was in
              // flight must show as "Brief changed", not be stamped over.
              current.brief,
              minted.ids.map((id) => `s${id}`),
              'brief',
            );
          }
          return { ...next, versions };
        });
        setFailed((prev) => ({ ...prev, ...failures }));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('writeFailed'));
      } finally {
        setWriting([]);
      }
    },
    [
      conversationId,
      modelId,
      mintIds,
      setState,
      t,
      blockedReason,
      effectiveSetId,
      sendableVoices,
    ],
  );

  /** Uploads images (downscaled, like the data workflow's) onto one post. */
  const addImages = async (
    specId: string,
    segmentId: string,
    files: File[],
  ) => {
    setError(null);
    setMediaBusyId(segmentId);
    try {
      const uploaded = await uploadPhotos(files);
      updateVersion(specId, (version) => {
        let segments = version.segments;
        for (const photo of uploaded) {
          segments = addMedia(segments, segmentId, {
            id: crypto.randomUUID(),
            ref: photo.url,
            name: photo.originalFilename,
            // Empty on purpose: what an image shows is for a person to say,
            // and an empty alt text is a finding until they do.
            alt: '',
          });
        }
        return setSegments(version, segments);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('imageUploadFailed'));
    } finally {
      setMediaBusyId(null);
    }
  };

  /** Asks for a suggested alt text. It fills the field; the user owns it. */
  const suggestAlt = async (
    specId: string,
    segmentId: string,
    mediaId: string,
  ) => {
    const current = liveState(conversationId);
    const item = current?.versions[specId]?.segments
      .find((segment) => segment.id === segmentId)
      ?.media?.find((entry) => entry.id === mediaId);
    if (!current || !item) return;
    setError(null);
    setMediaBusyId(mediaId);
    try {
      const alt = await suggestAltText({
        specKind: SPEC_KIND,
        imageRef: item.ref,
        language: current.brief.language || 'English',
        modelId,
        conversationId,
      });
      if (alt) {
        updateVersion(specId, (version) =>
          setSegments(
            version,
            setMediaAlt(version.segments, segmentId, mediaId, alt),
          ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('altSuggestFailed'));
    } finally {
      setMediaBusyId(null);
    }
  };

  /** Sends one approved post to Hootsuite, through the user's own connector. */
  const sendToHootsuite = async (specId: string) => {
    const current = liveState(conversationId);
    const version = current?.versions[specId];
    if (!current || !version || !hootsuite) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    setError(null);
    setSendingId(specId);
    try {
      const authToken =
        hootsuite.authMode === 'oauth'
          ? await ensureFreshOauthToken(hootsuite)
          : hootsuite.authToken;
      if (!authToken) throw new Error(t('sendNotConnected'));
      await sendPost({
        setId: current.setId ?? effectiveSetId,
        channelId: specId,
        version: {
          segments: version.segments,
          briefDigest: version.briefDigest,
          approvalTexts: version.approval?.texts ?? null,
          hasPendingSuggestions: pendingEdits(version).length > 0,
          hasProposal: !!version.proposed,
        },
        brief: {
          keyMessage: current.brief.keyMessage,
          callToAction: current.brief.callToAction,
          links: current.brief.links,
          language: current.brief.language || 'English',
          // Every item, with its decision: the gate must see what was left out.
          items: current.brief.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            text: item.text,
            attribution: item.attribution,
            verified: item.verified,
            decision: item.decision,
          })),
        },
        server: {
          id: hootsuite.id,
          name: hootsuite.name,
          catalogKey: HOOTSUITE_PUBLISHING.catalogKey,
          authToken,
        },
      });
      updateVersion(specId, (v) => markSent(v, new Date().toISOString()));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sendFailed'));
    } finally {
      setSendingId(null);
    }
  };

  /**
   * Reviews the channels in view (the focused one, or every visible one)
   * against the built-in criteria and the chosen guides. Findings arrive as
   * suggestions, exactly like a revision.
   */
  /**
   * "Shorten to fit": the server measures the overage, asks for cuts, checks
   * that they fit and tries again if not. What comes back lands as ordinary
   * suggestions; nothing is changed until the user accepts.
   */
  const tighten = async (specId: string, segmentId: string) => {
    const current = liveState(conversationId);
    const version = current?.versions[specId];
    if (!current || !version || tightening) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    setError(null);
    setTightening({ specId, segmentId });
    try {
      const response = await reviseVersions({
        specKind: SPEC_KIND,
        setId: current.setId ?? effectiveSetId,
        mode: 'tighten',
        instruction: '',
        targets: [
          {
            specId,
            segmentId,
            segments: version.segments.map((segment) => ({
              id: segment.id,
              text: segment.text,
            })),
          },
        ],
        brief: {
          keyMessage: current.brief.keyMessage,
          callToAction: current.brief.callToAction,
          links: current.brief.links,
          language: current.brief.language || 'English',
          items: includedItems(current.brief).map((item) => ({
            id: item.id,
            kind: item.kind,
            text: item.text,
            attribution: item.attribution,
            verified: item.verified,
          })),
        },
        ...sendableVoices(current, [specId]),
        modelId,
        conversationId,
      });
      const result = response.results.find((r) => r.specId === specId);
      if (!result || result.error || result.edits.length === 0) {
        setError(t('tightenNothing'));
        return;
      }
      setState((prev) => {
        const target = prev.versions[specId];
        if (!target) return prev;
        const { ids, next } = mintIds(prev, result.edits.length);
        return {
          ...next,
          versions: {
            ...next.versions,
            [specId]: landEdits(
              target,
              result.edits,
              next.brief,
              ids.map((id) => `e${id}`),
              t('tightenInstruction'),
              segmentId,
            ),
          },
        };
      });
      if ((result.stillOver ?? 0) > 0) {
        setError(t('tightenStillOver', { count: result.stillOver ?? 0 }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tightenNothing'));
    } finally {
      setTightening(null);
    }
  };

  const runCheck = async () => {
    const current = liveState(conversationId);
    if (!current) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    const specIds = (focusedId ? [focusedId] : current.specIds).filter(
      (id) =>
        !current.layout.hidden.includes(id) && hasText(current.versions[id]),
    );
    if (specIds.length === 0) return;
    setError(null);
    setChecking(true);
    try {
      const response = await assessVersions({
        specKind: SPEC_KIND,
        setId: current.setId ?? effectiveSetId,
        targets: specIds.map((specId) => ({
          specId,
          segments: current.versions[specId].segments.map((segment) => ({
            id: segment.id,
            text: segment.text,
          })),
        })),
        brief: {
          keyMessage: current.brief.keyMessage,
          callToAction: current.brief.callToAction,
          links: current.brief.links,
          language: current.brief.language || 'English',
          items: includedItems(current.brief).map((item) => ({
            id: item.id,
            kind: item.kind,
            text: item.text,
            attribution: item.attribution,
            verified: item.verified,
          })),
        },
        ...sendableVoices(current, specIds),
        guideIds: current.guideIds,
        modelId,
        conversationId,
      });
      setCriterionNames(
        Object.fromEntries(
          response.guides.map((guide) => [guide.criterionId, guide.name]),
        ),
      );
      const failures: Record<string, string> = {};
      setState((prev) => {
        let next = prev;
        const versions = { ...prev.versions };
        for (const result of response.results) {
          if (result.error) {
            failures[result.specId] = result.error;
            continue;
          }
          const version = versions[result.specId];
          if (!version) continue;
          const minted = mintIds(next, result.edits.length);
          next = minted.next;
          versions[result.specId] = landEdits(
            version,
            result.edits,
            next.brief,
            minted.ids.map((id) => `e${id}`),
            '',
          );
        }
        return { ...next, versions };
      });
      setFailed((prev) => ({ ...prev, ...failures }));
      setCheckOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('checkFailed'));
    } finally {
      setChecking(false);
    }
  };

  const toggleGuide = (criterionId: string) => {
    const guideId = guideIdFromCriterionId(criterionId);
    setState((prev) => {
      const on = prev.guideIds.includes(guideId);
      if (!on && prev.guideIds.length >= MAX_GUIDES_PER_ASSESSMENT) return prev;
      return {
        ...prev,
        guideIds: on
          ? prev.guideIds.filter((id) => id !== guideId)
          : [...prev.guideIds, guideId],
      };
    });
  };

  /**
   * Changing a channel's voice rewrites that channel. Over existing text the
   * rewrite arrives as a proposal (Keep mine / Use new), so the user's words
   * are never replaced just because they tried another voice.
   */
  const setVoice = (specId: string, ref: ToneRef | null) => {
    updateVersion(specId, (version) => {
      const same =
        version.toneRef?.kind === ref?.kind && version.toneRef?.id === ref?.id;
      if (same) return version;
      const { toneRef: _previous, ...rest } = version;
      return ref ? { ...rest, toneRef: ref } : rest;
    });
    if (hasText(liveState(conversationId)?.versions[specId])) {
      void write([specId]);
    }
  };

  /**
   * "Always do this here?" Adds the accepted instruction to the channel's
   * voice, or just records that it was offered. An organisation guide cannot
   * be edited, so there the rule goes into a personal copy, which the
   * channel then uses. Neither path rewrites the post: the text already
   * carries the change the user accepted.
   */
  const teach = async (
    specId: string,
    instruction: string,
    accept: boolean,
  ) => {
    const ref = liveState(conversationId)?.versions[specId]?.toneRef;
    let nextRef: ToneRef | undefined;
    if (accept && ref?.kind === 'tone') {
      const tone = useSettingsStore
        .getState()
        .tones.find((entry) => entry.id === ref.id);
      if (tone) {
        updateTone(tone.id, {
          voiceRules: appendVoiceRule(tone.voiceRules, instruction),
          updatedAt: new Date().toISOString(),
        });
      }
    } else if (accept && ref?.kind === 'guide') {
      try {
        const response = await fetch(`/api/guides/${ref.id}`);
        const json = (await response.json()) as {
          data?: { guide?: { voiceRules?: string; examples?: string } };
        };
        const guide = json.data?.guide;
        const name = voices.find(
          (voice) => voice.shared && voice.ref.id === ref.id,
        )?.name;
        if (!response.ok || !guide?.voiceRules) throw new Error('unavailable');
        const copy = {
          id: crypto.randomUUID(),
          name: t('teachCopyName', { voice: name ?? '' }).trim(),
          description: '',
          voiceRules: appendVoiceRule(guide.voiceRules, instruction),
          examples: guide.examples,
          createdAt: new Date().toISOString(),
          folderId: null,
        };
        addTone(copy);
        nextRef = { kind: 'tone', id: copy.id };
      } catch {
        setError(t('teachFailed'));
        return;
      }
    }
    updateVersion(specId, (version) => {
      const marked = markTaught(version, instruction);
      return nextRef ? { ...marked, toneRef: nextRef } : marked;
    });
  };

  /** Applies a saved set; channels it does not name keep their voice. */
  const applyVoiceSet = (voiceSetId: string) => {
    const voiceSet = voiceSets.find((entry) => entry.id === voiceSetId);
    if (!voiceSet) return;
    const changed: string[] = [];
    setState((prev) => {
      const versions = { ...prev.versions };
      for (const specId of prev.specIds) {
        const ref = voiceSet.bySpec[specId];
        const current = versions[specId] ?? emptyVersion(specId);
        if (!ref) continue;
        if (
          current.toneRef?.kind === ref.kind &&
          current.toneRef.id === ref.id
        ) {
          continue;
        }
        versions[specId] = { ...current, toneRef: ref };
        if (hasText(current)) changed.push(specId);
      }
      return { ...prev, voiceSetId, versions };
    });
    if (changed.length > 0) void write(changed);
  };

  const handlePrimary = () => {
    setBrief(includeAllVerified);
    const current = liveState(conversationId);
    if (!current) return;
    if (current.specIds.length === 0) {
      setError(t('pickChannels'));
      return;
    }
    const anyText = current.specIds.some((id) => hasText(current.versions[id]));
    const stale = current.specIds.filter((id) =>
      isStale(current.versions[id], current.brief),
    );
    const empty = current.specIds.filter(
      (id) => !hasText(current.versions[id]),
    );
    const targets = !anyText
      ? current.specIds
      : stale.length + empty.length > 0
        ? [...new Set([...stale, ...empty])]
        : current.specIds;
    void write(targets);
  };

  /* ---------------- channels ---------------- */

  const toggleChannel = (specId: string) => {
    setState((prev) => {
      const inPlay = prev.specIds.includes(specId);
      if (!inPlay && prev.specIds.length >= DRAFTER_LIMITS.MAX_SPECS) {
        return prev;
      }
      return {
        ...prev,
        // Leaving play keeps the version: re-adding the channel restores it.
        specIds: inPlay
          ? prev.specIds.filter((id) => id !== specId)
          : [...prev.specIds, specId],
        versions: inPlay
          ? prev.versions
          : withDefaultVoices(
              prev.versions,
              [specId],
              activeSet?.defaultVoices ?? {},
              readableGuideIds,
            ),
      };
    });
  };

  /**
   * Moves the draft to another rule set. Versions were written under other
   * rules, so the texts stay as they are and the checks simply re-run;
   * channels the new set does not offer leave play, their text kept.
   */
  const chooseSet = (nextSetId: string) => {
    setSetsOpen(false);
    const set = sets.find((entry) => entry.id === nextSetId);
    if (!set) return;
    setLastChannelSetId(nextSetId);
    // A refusal shown for the old set ("paused") no longer applies.
    setError(null);
    const offers = (id: string) =>
      set.channels.some((channel) => channel.id === id);
    // Focus on a channel that leaves play would address nothing.
    if (focusId && !offers(focusId)) setFocusId(null);
    let dropped = 0;
    setState((prev) => {
      if (prev.setId === nextSetId) return prev;
      const specIds = prev.specIds.filter(offers);
      dropped = prev.specIds.length - specIds.length;
      return { ...prev, setId: nextSetId, specIds };
    });
    setNotice(
      dropped > 0 ? t('setSwitched', { set: set.name, count: dropped }) : null,
    );
  };

  const toggleHidden = (specId: string) => {
    setState((prev) => {
      const hidden = prev.layout.hidden.includes(specId)
        ? prev.layout.hidden.filter((id) => id !== specId)
        : [...prev.layout.hidden, specId];
      return { ...prev, layout: { ...prev.layout, hidden } };
    });
  };

  const togglePinned = (specId: string) => {
    setState((prev) => {
      const pinned = prev.layout.pinned.includes(specId)
        ? prev.layout.pinned.filter((id) => id !== specId)
        : // At most two pinned columns, so the rest always have room.
          [...prev.layout.pinned, specId].slice(-2);
      return { ...prev, layout: { ...prev.layout, pinned } };
    });
  };

  /** Moves a channel one place earlier or later in the user's order. */
  const moveSpec = (specId: string, delta: -1 | 1) => {
    setState((prev) => {
      const from = prev.specIds.indexOf(specId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.specIds.length) return prev;
      const specIds = [...prev.specIds];
      [specIds[from], specIds[to]] = [specIds[to], specIds[from]];
      return { ...prev, specIds };
    });
  };

  /**
   * "Compare only": Shift-pressing channel names shows exactly that set. The
   * first Shift-press starts a set of one; further ones add to it.
   */
  const compareOnly = (specId: string) => {
    setState((prev) => {
      const inPlay = prev.specIds;
      const shown = inPlay.filter((id) => !prev.layout.hidden.includes(id));
      const narrowed = shown.length < inPlay.length;
      const keep =
        narrowed && !shown.includes(specId) ? [...shown, specId] : [specId];
      return {
        ...prev,
        layout: {
          ...prev.layout,
          hidden: inPlay.filter((id) => !keep.includes(id)),
        },
      };
    });
  };

  const resolveAllSuggestions = (accept: boolean) => {
    const now = new Date().toISOString();
    setState((prev) => {
      const versions = { ...prev.versions };
      for (const id of prev.specIds) {
        const version = versions[id];
        if (!version || pendingEdits(version).length === 0) continue;
        versions[id] = accept
          ? acceptAllEdits(version, now, prev.brief)
          : discardPendingEdits(version, now);
      }
      return { ...prev, versions };
    });
  };

  const showAll = () => {
    setState((prev) =>
      prev.layout.hidden.length === 0
        ? prev
        : { ...prev, layout: { ...prev.layout, hidden: [] } },
    );
  };

  const readyIds = specsInPlay
    .map((profile) => profile.id)
    .filter(
      (id) =>
        state &&
        !state.layout.hidden.includes(id) &&
        derived[id]?.statuses[0] !== 'approved' &&
        isReadyToApprove(state.versions[id], {
          brief: state.brief,
          blocking: blockingCount(derived[id]?.findings ?? []),
        }),
    );

  const approveAllReady = () => {
    const now = new Date().toISOString();
    setState((prev) => {
      const versions = { ...prev.versions };
      for (const id of readyIds) {
        const version = versions[id];
        if (version) versions[id] = approveVersion(version, now);
      }
      return { ...prev, versions };
    });
  };

  /**
   * Translates the brief and opens a new draft in that language, with the
   * same sources, channels, voices and links. This draft is left as it is.
   * Translated items arrive undecided, so each quotation is reviewed once in
   * its new language before anything is written from it.
   */
  const draftInLanguage = async (languageId: string) => {
    const current = liveState(conversationId);
    const language = findTranslationLanguage(languageId);
    if (!current || !language || models.length === 0) return;
    const sourceLanguage = current.brief.language || 'English';
    if (language.name === sourceLanguage) return;
    const carried = current.brief.items.filter(
      (item) => item.decision !== 'excluded',
    );
    setError(null);
    setBusy(t('translatingBrief', { language: language.name }));
    try {
      const translation = await translateBrief({
        specKind: SPEC_KIND,
        sourceLanguage,
        targetLanguage: language.name,
        keyMessage: current.brief.keyMessage,
        callToAction: current.brief.callToAction,
        items: carried.map((item) => ({
          id: item.id,
          kind: item.kind,
          text: item.text,
          role: item.attribution?.role,
        })),
        modelId,
        conversationId,
      });
      const conversation = createWorkflowConversation(
        models,
        defaultModelId,
        systemPrompt || '',
        temperature || 0.5,
        KIND,
        {
          ...translatedDraftState(
            current,
            translation,
            language.name,
            new Date().toISOString(),
          ),
          // Written under the same rules as this draft.
          setId: current.setId ?? effectiveSetId,
        },
      );
      const here = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversationId);
      // addConversation selects the new draft, so the user lands in it.
      addConversation({
        ...conversation,
        name: `${here?.name || t('untitledDraft')} (${language.name})`,
        nameAutoGenerated: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('translateFailed'));
    } finally {
      setBusy(null);
    }
  };

  /** The sign-off document, downloaded; nothing is sent anywhere. */
  const downloadReviewPack = () => {
    if (!state) return;
    const pack = buildReviewPack(
      state,
      specsInPlay.map((profile) => {
        const version = state.versions[profile.id];
        const findings = derived[profile.id]?.findings ?? [];
        return {
          id: profile.id,
          name: profile.name,
          renderedTexts: version
            ? channelAdapterUi
                .copyPlan(profile, version)
                .map((step) => step.text)
            : [],
          media: (version?.segments ?? []).map((segment) =>
            (segment.media ?? []).map((item) => ({
              name: item.name,
              alt: item.alt,
            })),
          ),
          findings,
          findingMessages: findings.map((finding) =>
            finding.scope === 'kind'
              ? tKind(`checks.${finding.messageKey}`, finding.values)
              : t(`checks.${finding.messageKey}`, finding.values),
          ),
        };
      }),
      {
        title: t('pack.title'),
        generated: t('pack.generated'),
        brief: t('brief'),
        keyMessage: t('keyMessage'),
        callToAction: t('callToAction'),
        links: t('links'),
        linkRoles: {
          article: t('pack.linkArticle'),
          donation: t('pack.linkDonation'),
        },
        items: t('pack.items'),
        kinds: {
          quote: t('kinds.quote'),
          testimony: t('kinds.testimony'),
          fact: t('kinds.fact'),
          figure: t('kinds.figure'),
          context: t('kinds.context'),
        },
        verification: {
          verbatim: t('foundInSource'),
          'user-asserted': t('pack.vouched'),
          unverified: t('notFoundInSource'),
        },
        versions: t('pack.versions'),
        post: (n) => t('pack.post', { n }),
        approved: (at) =>
          t('pack.approved', { date: new Date(at).toLocaleString() }),
        notApproved: t('pack.notApproved'),
        approvalChanged: t('changedSinceApproved'),
        briefChanged: t('pack.briefChanged'),
        proof: (traced, total, vouched) =>
          vouched > 0
            ? `${t('proofSummary', { traced, total })} · ${t('proofVouched', { count: vouched })}`
            : t('proofSummary', { traced, total }),
        checks: t('findings'),
        provenance: t('pack.provenance'),
        provenanceColumns: [
          t('pack.colItem'),
          t('pack.colStatus'),
          t('pack.colSource'),
          t('pack.colPassage'),
        ],
        noSource: t('pack.noSource'),
        image: (name) => t('pack.image', { name }),
        altMissing: t('pack.altMissing'),
      },
      new Date().toLocaleString(),
    );
    downloadBlob(
      new Blob([pack], { type: 'text/markdown;charset=utf-8' }),
      'review-pack.md',
    );
  };

  const copyBrief = async () => {
    if (!brief) return;
    const lines = [
      brief.keyMessage,
      ...includedItems(brief).map((item) =>
        item.kind === 'quote' || item.kind === 'testimony'
          ? `“${item.text}”${item.attribution ? ` (${item.attribution.name})` : ''}`
          : item.text,
      ),
      brief.callToAction ?? '',
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n\n'));
    } catch {
      // Clipboard denied: nothing to undo.
    }
  };

  if (!state || !brief || !adapter) return null;

  const visible = specsInPlay.filter(
    (profile) => !state.layout.hidden.includes(profile.id),
  );
  const ordered = [
    ...visible.filter((profile) => state.layout.pinned.includes(profile.id)),
    ...visible.filter((profile) => !state.layout.pinned.includes(profile.id)),
  ];
  // The article link is offered when the draft rests on exactly one web
  // page. Once included it stays switchable even if more pages are added.
  const pages = state.sources.filter(
    (source) => source.kind === 'url' && !source.error && !!source.url,
  );
  const includedArticle = briefLink(brief, 'article');
  const articleSource = includedArticle
    ? { name: includedArticle.label, url: includedArticle.url }
    : pages.length === 1 && pages[0].url
      ? { name: pages[0].name, url: pages[0].url }
      : undefined;

  /** The gate's reasons, plus the one only this workspace knows. */
  const sendBlockersFor = (specId: string): SendBlocker[] => {
    const version = state.versions[specId];
    const blockers: SendBlocker[] = publishBlockers(
      version,
      brief,
      derived[specId]?.findings ?? [],
      { allowVouched: HOOTSUITE_PUBLISHING.allowVouched },
    );
    // A thread needs reply-chaining, which the tool may not offer.
    if ((version?.segments.length ?? 0) > 1) blockers.push('thread');
    // The tool's media arguments are unknown, and sending the words without
    // the image would post something the user never approved.
    if (hasMedia(version)) blockers.push('media');
    return blockers;
  };

  const teachOfferFor = (specId: string) => {
    const instruction = teachableInstruction(state, specId);
    const ref = state.versions[specId]?.toneRef;
    const voice = ref
      ? voices.find((v) => v.ref.kind === ref.kind && v.ref.id === ref.id)
      : undefined;
    return instruction && voice
      ? { instruction, voiceName: voice.name, shared: voice.shared }
      : undefined;
  };

  const focused = focusedId
    ? specsInPlay.find((profile) => profile.id === focusedId)
    : undefined;
  const hiddenCount = specsInPlay.length - visible.length;
  const savedVoiceSets = voiceSets.filter(
    (entry) => entry.specKind === SPEC_KIND,
  );
  /** Brings a column into view and puts the keyboard on it. */
  const jumpToChannel = (specId: string) => {
    const header = headerRefs.current[specId];
    if (!header) return;
    header.focus();
    header.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };
  const writtenVisible = visible.filter((profile) =>
    hasText(state.versions[profile.id]),
  );
  const allPreviewing =
    writtenVisible.length > 0 &&
    writtenVisible.every((profile) => previewing[profile.id]);
  // Channels this draft uses that the user no longer has: switched off,
  // removed or restricted by an admin since. Their text is kept in the draft,
  // untouched. Only judged once the server's list has arrived, so a channel
  // of the organisation's own is not called unavailable while it loads.
  const unavailableCount = isAuthoritative
    ? state.specIds.filter(
        (id) => !channels.some((profile) => profile.id === id),
      ).length
    : 0;
  const suggestionTotals = specsInPlay.reduce(
    (totals, profile) => {
      const count = pendingEdits(state.versions[profile.id]).length;
      return count > 0
        ? { edits: totals.edits + count, channels: totals.channels + 1 }
        : totals;
    },
    { edits: 0, channels: 0 },
  );

  /** 1-9 jump to a column; [ and ] move between channels in Focus; Esc leaves. */
  const onWorkspaceKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    if (focused) {
      const index = specsInPlay.findIndex((p) => p.id === focused.id);
      if (event.key === 'Escape') {
        setFocusId(null);
        // Return focus to the column the user came from.
        window.setTimeout(() => headerRefs.current[focused.id]?.focus(), 0);
      } else if (event.key === '[' && index > 0) {
        setFocusId(specsInPlay[index - 1].id);
      } else if (event.key === ']' && index < specsInPlay.length - 1) {
        setFocusId(specsInPlay[index + 1].id);
      }
      return;
    }
    if (/^[1-9]$/u.test(event.key)) {
      const profile = ordered[Number(event.key) - 1];
      const header = profile ? headerRefs.current[profile.id] : null;
      if (header) {
        event.preventDefault();
        header.focus();
        header.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    }
  };

  const hasVersions = specsInPlay.some((profile) =>
    hasText(state.versions[profile.id]),
  );
  const staleCount = specsInPlay.filter((profile) =>
    isStale(state.versions[profile.id], brief),
  ).length;

  const renderColumn = (
    profile: ChannelProfile,
    layout: 'column' | 'focus',
  ) => {
    const info = derived[profile.id];
    const pinned = state.layout.pinned.includes(profile.id);
    const position = state.specIds.indexOf(profile.id);
    return (
      <div
        key={profile.id}
        className={
          layout === 'focus'
            ? 'flex min-w-0 flex-1'
            : pinned
              ? 'sticky start-0 z-10 flex bg-white dark:bg-surface-dark'
              : 'flex'
        }
      >
        <VersionColumn
          spec={profile}
          version={state.versions[profile.id]}
          ui={channelAdapterUi as never}
          statuses={info?.statuses ?? ['empty']}
          findings={info?.findings ?? []}
          marks={info?.marks ?? []}
          layout={layout}
          brief={brief}
          sources={state.sources}
          canMoveEarlier={position > 0}
          canMoveLater={position < state.specIds.length - 1}
          registerHeader={(node) => {
            headerRefs.current[profile.id] = node;
          }}
          onMove={(delta) => moveSpec(profile.id, delta)}
          onFocusMode={() => setFocusId(profile.id)}
          onAcceptEdit={(editId) =>
            updateVersion(profile.id, (version) =>
              acceptEdit(
                version,
                editId,
                new Date().toISOString(),
                liveState(conversationId)?.brief,
              ),
            )
          }
          onRejectEdit={(editId) =>
            updateVersion(profile.id, (version) =>
              rejectEdit(version, editId, new Date().toISOString()),
            )
          }
          onAcceptAllEdits={() =>
            updateVersion(profile.id, (version) =>
              acceptAllEdits(
                version,
                new Date().toISOString(),
                liveState(conversationId)?.brief,
              ),
            )
          }
          voices={voices}
          teachOffer={teachOfferFor(profile.id)}
          onTeach={(accept) => {
            const offer = teachOfferFor(profile.id);
            if (offer) void teach(profile.id, offer.instruction, accept);
          }}
          criterionNames={criterionNames}
          onVoice={(ref) => setVoice(profile.id, ref)}
          send={
            !blockedReason &&
            publishAccess.data?.configured &&
            publishAccess.data.channels.includes(
              publishRuleName(effectiveSetId, profile.id),
            )
              ? {
                  blockers: sendBlockersFor(profile.id),
                  connected: !!hootsuite,
                  sending: sendingId === profile.id,
                }
              : undefined
          }
          onSend={() => void sendToHootsuite(profile.id)}
          media={{
            busyId: mediaBusyId,
            onAdd: (segmentId, files) =>
              void addImages(profile.id, segmentId, files),
            onRemove: (segmentId, mediaId) =>
              updateVersion(profile.id, (version) =>
                setSegments(
                  version,
                  removeMedia(version.segments, segmentId, mediaId),
                ),
              ),
            onAlt: (segmentId, mediaId, alt) =>
              updateVersion(profile.id, (version) =>
                setSegments(
                  version,
                  setMediaAlt(version.segments, segmentId, mediaId, alt),
                ),
              ),
            onSuggestAlt: (segmentId, mediaId) =>
              void suggestAlt(profile.id, segmentId, mediaId),
          }}
          previewing={!!previewing[profile.id]}
          onPreviewChange={(on) =>
            setPreviewing((prev) => ({ ...prev, [profile.id]: on }))
          }
          onRevise={(segmentId) => revise(profile.id, segmentId)}
          onRestore={(snapshot) =>
            setState((prev) => {
              const version = prev.versions[profile.id];
              if (!version) return prev;
              const { ids, next } = mintIds(prev, snapshot.texts.length);
              return {
                ...next,
                versions: {
                  ...next.versions,
                  [profile.id]: restoreSnapshot(
                    version,
                    snapshot,
                    ids.map((id) => `s${id}`),
                    new Date().toISOString(),
                  ),
                },
              };
            })
          }
          writing={writing.includes(profile.id)}
          error={failed[profile.id]}
          pinned={pinned}
          tracedItemId={tracedItemId}
          onTrace={setTracedItemId}
          onEdit={(segmentId, text) =>
            updateVersion(profile.id, (version) =>
              editSegmentText(version, segmentId, text),
            )
          }
          onSplit={(segmentId, caret) =>
            setState((prev) => {
              const version = prev.versions[profile.id];
              if (!version) return prev;
              const { ids, next } = mintIds(prev, 1);
              const segments = splitSegment(
                version.segments,
                segmentId,
                caret,
                `s${ids[0]}`,
              );
              if (segments === version.segments) return prev;
              return {
                ...next,
                versions: {
                  ...next.versions,
                  [profile.id]: setSegments(version, segments),
                },
              };
            })
          }
          onMerge={(segmentId) =>
            updateVersion(profile.id, (version) =>
              setSegments(
                version,
                mergeWithPrevious(version.segments, segmentId),
              ),
            )
          }
          onFit={() =>
            setState((prev) => {
              const version = prev.versions[profile.id];
              if (!version || !channelAdapterUi.fit) return prev;
              // A dry run says how many new posts it takes, so exactly that
              // many ids are minted in this same write.
              let dry = 0;
              channelAdapterUi.fit(
                profile,
                version.segments,
                prev.brief,
                () => `dry${(dry += 1)}`,
              );
              const { ids, next } = mintIds(prev, dry);
              let used = 0;
              const segments = channelAdapterUi.fit(
                profile,
                version.segments,
                prev.brief,
                () => `s${ids[used++] ?? `x${used}`}`,
              );
              if (segments === version.segments) return prev;
              return {
                ...next,
                versions: {
                  ...next.versions,
                  [profile.id]: setSegments(version, segments),
                },
              };
            })
          }
          onDropHashtags={(segmentId) =>
            updateVersion(profile.id, (version) => {
              const current = liveState(conversationId);
              const segments = channelAdapterUi.dropHashtags?.(
                profile,
                version.segments,
                segmentId,
                current?.brief ?? state.brief,
              );
              return segments && segments !== version.segments
                ? setSegments(version, segments)
                : version;
            })
          }
          onTighten={(segmentId) => void tighten(profile.id, segmentId)}
          tighteningId={
            tightening?.specId === profile.id ? tightening.segmentId : null
          }
          onApprove={(approved) =>
            updateVersion(profile.id, (version) =>
              approved
                ? approveVersion(version, new Date().toISOString())
                : clearApproval(version),
            )
          }
          onCopied={() =>
            updateVersion(profile.id, (version) =>
              markCopied(version, new Date().toISOString()),
            )
          }
          onUseProposed={() =>
            setState((prev) => {
              const version = prev.versions[profile.id];
              if (!version) return prev;
              return {
                ...prev,
                versions: {
                  ...prev.versions,
                  [profile.id]: acceptProposed(
                    version,
                    prev.brief,
                    new Date().toISOString(),
                  ),
                },
              };
            })
          }
          onKeepMine={() =>
            setState((prev) => {
              const version = prev.versions[profile.id];
              if (!version) return prev;
              return {
                ...prev,
                versions: {
                  ...prev.versions,
                  [profile.id]: keepMine(version, prev.brief),
                },
              };
            })
          }
          onHide={() => toggleHidden(profile.id)}
          onTogglePin={() => togglePinned(profile.id)}
          onRetry={() => void write([profile.id])}
        />
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onWorkspaceKey}>
      <div className="flex items-center gap-1 border-b border-gray-200 px-2 py-1 dark:border-gray-700">
        <button
          type="button"
          className={toolbarButton}
          aria-expanded={briefOpen}
          aria-label={briefOpen ? t('collapseBrief') : t('expandBrief')}
          title={briefOpen ? t('collapseBrief') : t('expandBrief')}
          onClick={() => setBriefOpen((open) => !open)}
        >
          {briefOpen ? (
            <IconLayoutSidebarLeftCollapse
              size={16}
              aria-hidden
              className="rtl:-scale-x-100"
            />
          ) : (
            <IconLayoutSidebarLeftExpand
              size={16}
              aria-hidden
              className="rtl:-scale-x-100"
            />
          )}
        </button>
        {/* The channels in play, one pill each, with the column's status as
            a dot: the bar is an overview as well as a way to jump. Adding
            and hiding channels lives behind "+", a once-per-draft act. */}
        <div
          role="group"
          aria-label={t('channels')}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {specsInPlay.map((profile) => {
            const hidden = state.layout.hidden.includes(profile.id);
            const status = derived[profile.id]?.statuses[0] ?? 'empty';
            return (
              <button
                key={profile.id}
                type="button"
                className={`inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-sm hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:hover:bg-surface-dark-elevated ${
                  hidden
                    ? 'border-dashed border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-500'
                    : 'border-gray-300 text-gray-900 dark:border-gray-600 dark:text-gray-100'
                }`}
                aria-label={
                  hidden
                    ? t('showChannel', { channel: profile.name })
                    : t('jumpToChannel', { channel: profile.name })
                }
                title={`${profile.name} · ${t(`statusShort.${status}`)}${
                  hidden ? '' : ` · ${t('compareOnlyHint')}`
                }`}
                onClick={(event) => {
                  if (hidden) toggleHidden(profile.id);
                  else if (event.shiftKey) compareOnly(profile.id);
                  else jumpToChannel(profile.id);
                }}
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                />
                {shortSpecName(profile.name)}
              </button>
            );
          })}
        </div>
        <span className="relative shrink-0">
          <button
            type="button"
            className={toolbarButton}
            aria-label={t('addChannels')}
            title={t('addChannels')}
            aria-haspopup="dialog"
            aria-expanded={channelsOpen}
            onClick={() => setChannelsOpen((open) => !open)}
          >
            <IconPlus size={16} aria-hidden />
          </button>
          <Popover
            open={channelsOpen}
            onClose={() => setChannelsOpen(false)}
            placement="below-start"
            className="w-64"
          >
            <p className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400">
              {t('channelsPickerHint')}
            </p>
            {channels.map((profile) => {
              const inPlay = state.specIds.includes(profile.id);
              const hidden = state.layout.hidden.includes(profile.id);
              return (
                <div
                  key={profile.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-gray-100 dark:hover:bg-surface-dark-elevated"
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-blue-600"
                      checked={inPlay}
                      onChange={() => toggleChannel(profile.id)}
                    />
                    <span className="truncate">{profile.name}</span>
                  </label>
                  {inPlay && (
                    <button
                      type="button"
                      className={iconButton}
                      aria-pressed={!hidden}
                      aria-label={
                        hidden
                          ? t('showChannel', { channel: profile.name })
                          : t('hideChannel', { channel: profile.name })
                      }
                      title={
                        hidden
                          ? t('showChannel', { channel: profile.name })
                          : t('hideChannel', { channel: profile.name })
                      }
                      onClick={() => toggleHidden(profile.id)}
                    >
                      {hidden ? (
                        <IconEyeOff size={14} aria-hidden />
                      ) : (
                        <IconEye size={14} aria-hidden />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </Popover>
        </span>
        {/* The rule set, only when there is a choice to make: one set means
            no set UI at all. */}
        {activeSet && (sets.length > 1 || setUnavailable) && (
          <span className="relative shrink-0">
            <button
              type="button"
              className={toolbarButton}
              aria-label={t('setPicker')}
              title={[t('setPicker'), activeSet.description, activeSet.language]
                .filter(Boolean)
                .join(' · ')}
              aria-haspopup="dialog"
              aria-expanded={setsOpen}
              onClick={() => setSetsOpen((open) => !open)}
            >
              <IconUsersGroup size={16} aria-hidden />
              <span className="max-w-[10rem] truncate">{activeSet.name}</span>
            </button>
            <Popover
              open={setsOpen}
              onClose={() => setSetsOpen(false)}
              placement="below-start"
              className="w-72"
            >
              <p className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400">
                {t('setPickerHint')}
              </p>
              {sets.map((set) => (
                <button
                  key={set.id}
                  type="button"
                  className={menuItem}
                  aria-current={set.id === effectiveSetId ? 'true' : undefined}
                  title={set.description || undefined}
                  onClick={() => chooseSet(set.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">
                        {set.name}
                        {set.language ? (
                          <span className="text-gray-500 dark:text-gray-400">
                            {` · ${set.language}`}
                          </span>
                        ) : null}
                      </span>
                      {set.isDefault && (
                        <span className="shrink-0 rounded-full bg-gray-100 px-1.5 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
                          {t('setDefaultBadge')}
                        </span>
                      )}
                    </span>
                    {set.grant !== 'everyone' && (
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {t(`setSharedWith.${set.grant}`)}
                      </span>
                    )}
                  </span>
                  {set.id === effectiveSetId && (
                    <IconChecks size={14} aria-hidden className="shrink-0" />
                  )}
                </button>
              ))}
            </Popover>
          </span>
        )}
        {namingVoiceSet !== null ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const name = namingVoiceSet.trim();
              if (!name) return;
              saveVoiceSet({
                id: crypto.randomUUID(),
                name: name.slice(0, 60),
                specKind: SPEC_KIND,
                bySpec: currentVoices(state),
              });
              setNamingVoiceSet(null);
            }}
          >
            <input
              autoFocus
              className="min-h-[36px] w-40 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
              aria-label={t('voiceSetName')}
              placeholder={t('voiceSetName')}
              value={namingVoiceSet}
              onChange={(event) => setNamingVoiceSet(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') setNamingVoiceSet(null);
              }}
            />
            <button type="submit" className={toolbarButton}>
              {t('save')}
            </button>
          </form>
        ) : (
          savedVoiceSets.length > 0 && (
            <select
              className="min-h-[36px] max-w-[160px] rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
              aria-label={t('voiceSet')}
              title={t('voiceSet')}
              value={
                savedVoiceSets.find((entry) =>
                  sameVoices(currentVoices(state), entry.bySpec),
                )?.id ?? ''
              }
              onChange={(event) => {
                if (event.target.value) applyVoiceSet(event.target.value);
              }}
            >
              <option value="">{t('voiceSet')}</option>
              {savedVoiceSets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )
        )}
        <button
          type="button"
          className={toolbarButton}
          aria-pressed={allPreviewing}
          aria-label={t('previewAll')}
          title={t('previewHint')}
          disabled={writtenVisible.length === 0}
          onClick={() =>
            setPreviewing((prev) => ({
              ...prev,
              ...Object.fromEntries(
                writtenVisible.map((profile) => [profile.id, !allPreviewing]),
              ),
            }))
          }
        >
          <IconEyeCheck size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={toolbarButton}
          aria-expanded={checkOpen}
          aria-label={t('check')}
          title={blockedReason ?? t('check')}
          disabled={
            !!blockedReason ||
            !specsInPlay.some((p) => hasText(state.versions[p.id]))
          }
          onClick={() => setCheckOpen((open) => !open)}
        >
          <IconClipboardCheck size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={toolbarButton}
          aria-label={t('revise')}
          title={blockedReason ?? t('revise')}
          disabled={
            !!blockedReason ||
            !specsInPlay.some((p) => hasText(state.versions[p.id]))
          }
          onClick={() => revise(focused?.id)}
        >
          <IconMessage2 size={16} aria-hidden />
        </button>
        {hiddenCount > 0 && (
          <button
            type="button"
            className={toolbarButton}
            aria-label={t('showAll', { count: specsInPlay.length })}
            title={t('showAll', { count: specsInPlay.length })}
            onClick={showAll}
          >
            <IconEye size={16} aria-hidden />
            {hiddenCount}
          </button>
        )}
        <button
          type="button"
          className={toolbarButton}
          aria-label={t('approveAllReady', { count: readyIds.length })}
          title={t('approveAllReady', { count: readyIds.length })}
          disabled={readyIds.length === 0}
          onClick={approveAllReady}
        >
          <IconChecks size={16} aria-hidden />
          {readyIds.length > 0 && (
            <span className="rounded-full bg-blue-600 px-1.5 text-xs font-medium text-white">
              {readyIds.length}
            </span>
          )}
        </button>
        <span className="relative">
          <button
            ref={languageButtonRef}
            type="button"
            className={toolbarButton}
            aria-label={t('moreActions')}
            title={t('moreActions')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <IconDotsVertical size={16} aria-hidden />
          </button>
          <Popover
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            placement="below-end"
            className="w-56"
          >
            <div role="menu" className="flex flex-col">
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={
                  !brief.keyMessage && includedItems(brief).length === 0
                }
                onClick={() => {
                  setMoreOpen(false);
                  void copyBrief();
                }}
              >
                <IconCopy size={16} aria-hidden />
                {t('copyBrief')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={
                  busy !== null ||
                  (!brief.keyMessage && includedItems(brief).length === 0)
                }
                title={t('inAnotherLanguageHint')}
                onClick={() => {
                  setMoreOpen(false);
                  setLanguagePickerOpen(true);
                }}
              >
                <IconLanguage size={16} aria-hidden />
                {t('inAnotherLanguage')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={
                  !specsInPlay.some((p) => hasText(state.versions[p.id]))
                }
                onClick={() => {
                  setMoreOpen(false);
                  downloadReviewPack();
                }}
              >
                <IconFileDownload size={16} aria-hidden />
                {t('reviewPack')}
              </button>
              {voices.length > 0 &&
                Object.keys(currentVoices(state)).length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    onClick={() => {
                      setMoreOpen(false);
                      setNamingVoiceSet('');
                    }}
                  >
                    <IconMicrophone size={16} aria-hidden />
                    {t('voiceSetSave')}
                  </button>
                )}
            </div>
          </Popover>
          <LanguagePicker
            triggerRef={languageButtonRef}
            isOpen={languagePickerOpen}
            onClose={() => setLanguagePickerOpen(false)}
            options={languageOptions}
            value={null}
            onSelect={(code) => {
              setLanguagePickerOpen(false);
              if (code) void draftInLanguage(code);
            }}
            ariaLabel={t('inAnotherLanguage')}
          />
        </span>
      </div>

      {checkOpen && (
        <div className="space-y-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-surface-dark-elevated">
          <p className="text-xs text-gray-700 dark:text-gray-300">
            {t('checkExplainer')}
          </p>
          {criterionGuides.length > 0 && (
            <GuidePicker
              guides={criterionGuides}
              selected={new Set(state.guideIds.map(guideCriterionId))}
              onToggle={toggleGuide}
              i18nNamespace="workflows.drafter"
              disabled={checking}
            />
          )}
          <button
            type="button"
            className="inline-flex min-h-[36px] items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-30"
            disabled={checking}
            onClick={() => void runCheck()}
          >
            <IconClipboardCheck size={16} aria-hidden />
            {checking
              ? t('checking')
              : focused
                ? t('checkChannel', { channel: focused.name })
                : t('checkVisible')}
          </button>
        </div>
      )}

      {m365Available && (
        <M365FilePickerModal
          isOpen={m365PickerOpen}
          onClose={() => setM365PickerOpen(false)}
          onPick={(entry) => void handleM365Pick(entry)}
          acceptExtensions={['docx', 'pdf', 'md', 'txt', 'html', 'htm', 'pptx']}
        />
      )}

      {noSets ? (
        <p
          role="status"
          className="border-b border-gray-200 px-3 py-1.5 text-sm text-amber-900 dark:border-gray-700 dark:text-amber-300"
        >
          {t('noSetsAvailable')}
        </p>
      ) : (
        setUnavailable &&
        activeSet && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1.5 text-sm text-amber-900 dark:border-gray-700 dark:text-amber-300"
          >
            <span className="min-w-0 flex-1">{blockedReason}</span>
            <button
              type="button"
              className={toolbarButton}
              onClick={() => chooseSet(activeSet.id)}
            >
              {t('moveToSet', { set: activeSet.name })}
            </button>
          </div>
        )
      )}
      {notice && (
        <p
          role="status"
          className="border-b border-gray-200 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300"
        >
          {notice}
        </p>
      )}
      {unavailableCount > 0 && (
        <p
          role="status"
          className="border-b border-gray-200 px-3 py-1.5 text-sm text-amber-900 dark:border-gray-700 dark:text-amber-300"
        >
          {t('channelsUnavailable', { count: unavailableCount })}
        </p>
      )}

      {(error || busy) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`border-b border-gray-200 px-3 py-1.5 text-sm dark:border-gray-700 ${
            error
              ? 'text-red-800 dark:text-red-300'
              : 'text-gray-700 dark:text-gray-300'
          }`}
        >
          {error ?? busy}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {briefOpen && (
          <div className="w-full shrink-0 border-e border-gray-200 md:w-[380px] dark:border-gray-700">
            {viewer ? (
              <SourceViewer
                sources={state.sources}
                sourceId={viewer.sourceId}
                resolving={
                  viewer.itemId
                    ? brief.items.find((item) => item.id === viewer.itemId)
                    : undefined
                }
                onSourceChange={(sourceId) =>
                  setViewer((prev) => (prev ? { ...prev, sourceId } : prev))
                }
                onAdd={(sourceId, selection, kind) =>
                  setState((prev) => {
                    const { ids, next } = mintIds(prev, 1);
                    return {
                      ...next,
                      brief: addItemFromSelection(
                        next.brief,
                        `i${ids[0]}`,
                        sourceId,
                        selection,
                        kind,
                      ),
                    };
                  })
                }
                onResolve={(itemId, sourceId, selection, supported) => {
                  setBrief((prev) =>
                    resolveItemFromSelection(
                      prev,
                      itemId,
                      sourceId,
                      selection,
                      supported,
                    ),
                  );
                  setViewer(null);
                }}
                onClose={() => setViewer(null)}
              />
            ) : (
              <BriefPane
                header={
                  <SourcesStrip
                    sources={state.sources}
                    busy={busy !== null || extracting}
                    onAddFile={(file) => void handleAddFile(file)}
                    onAddUrl={(url) => void handleAddUrl(url)}
                    onAddNote={(text) => void handleAddNote(text)}
                    onAddFromM365={
                      m365Available ? () => setM365PickerOpen(true) : undefined
                    }
                    onRemove={handleRemoveSource}
                  />
                }
                brief={brief}
                sources={state.sources}
                usedIn={usedIn}
                hasVersions={hasVersions}
                staleCount={staleCount}
                extracting={extracting}
                writing={writing.length > 0}
                paused={blockedReason !== null}
                tracedItemId={tracedItemId}
                onTrace={setTracedItemId}
                articleSource={articleSource}
                rememberedDonationUrl={
                  // The set's giving page stands in until the user has
                  // typed their own; it never turns the ask on.
                  rememberedDonationUrl || activeSet?.defaults.donationUrl || ''
                }
                onArticleLink={(include) =>
                  setBrief((prev) =>
                    setBriefLink(
                      prev,
                      'article',
                      include && articleSource
                        ? { label: articleSource.name, url: articleSource.url }
                        : null,
                    ),
                  )
                }
                onDonationLink={(url) => {
                  if (url) setDonationUrl(url);
                  setBrief((prev) =>
                    setBriefLink(
                      prev,
                      'donation',
                      url ? { label: 'Donate', url } : null,
                    ),
                  );
                }}
                onKeyMessage={(text) =>
                  setBrief((prev) => setKeyMessage(prev, text))
                }
                onCallToAction={(text) =>
                  setBrief((prev) => setCallToAction(prev, text))
                }
                onDecision={(itemId, decision) =>
                  setBrief((prev) => setItemDecision(prev, itemId, decision))
                }
                onVouch={(itemId) =>
                  setBrief((prev) => vouchForItem(prev, itemId))
                }
                onEditText={(itemId, text) => void handleEditItem(itemId, text)}
                onMove={(itemId, delta) =>
                  setBrief((prev) => moveItem(prev, itemId, delta))
                }
                onRemove={(itemId) =>
                  setBrief((prev) => removeItem(prev, itemId))
                }
                onAddOwn={(text) =>
                  setState((prev) => {
                    const { ids, next } = mintIds(prev, 1);
                    return {
                      ...next,
                      brief: addOwnItem(next.brief, `i${ids[0]}`, text),
                    };
                  })
                }
                onOpenSource={(sourceId, itemId) => {
                  const item = brief.items.find((entry) => entry.id === itemId);
                  const readable = state.sources.filter(
                    (entry) => !entry.error,
                  );
                  const target =
                    sourceId ??
                    item?.provenance[0]?.sourceId ??
                    readable[0]?.id;
                  if (target) setViewer({ sourceId: target, itemId });
                }}
                onPrimary={handlePrimary}
              />
            )}
          </div>
        )}

        <div
          className={`min-h-0 min-w-0 flex-1 snap-x overflow-x-auto ${
            briefOpen ? 'hidden md:flex' : 'flex'
          }`}
        >
          {focused ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div
                role="tablist"
                aria-label={t('channels')}
                className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 px-2 py-1 dark:border-gray-700"
              >
                <button
                  type="button"
                  className={toolbarButton}
                  onClick={() => setFocusId(null)}
                >
                  {t('backToCompare')}
                </button>
                {specsInPlay.map((profile) => {
                  const active = profile.id === focused.id;
                  const status = derived[profile.id]?.statuses[0] ?? 'empty';
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`min-h-[36px] shrink-0 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
                      }`}
                      onClick={() => setFocusId(profile.id)}
                    >
                      {profile.name}
                      <span className="ms-1 text-xs opacity-80">
                        {t(`statusShort.${status}`)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex min-h-0 flex-1">
                {renderColumn(focused, 'focus')}
              </div>
            </div>
          ) : (
            <>
              {ordered.length === 0 && (
                <p className="p-6 text-sm text-gray-700 dark:text-gray-300">
                  {specsInPlay.length === 0
                    ? t('pickChannels')
                    : t('allHidden')}
                </p>
              )}
              {ordered.map((profile) => renderColumn(profile, 'column'))}
            </>
          )}
        </div>
      </div>

      {suggestionTotals.edits > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-t border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
        >
          <span className="me-auto">
            {t('suggestionsBar', {
              edits: suggestionTotals.edits,
              channels: suggestionTotals.channels,
            })}
          </span>
          <button
            type="button"
            className={toolbarButton}
            onClick={() => resolveAllSuggestions(true)}
          >
            <IconChecks size={16} aria-hidden />
            {t('acceptAll', { count: suggestionTotals.edits })}
          </button>
          <button
            type="button"
            className={toolbarButton}
            onClick={() => resolveAllSuggestions(false)}
          >
            {t('discardAll')}
          </button>
        </div>
      )}
    </div>
  );
}
