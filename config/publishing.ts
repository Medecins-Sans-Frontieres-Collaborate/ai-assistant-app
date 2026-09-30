/**
 * Sending a finished post to Hootsuite (docs/CHANNEL_DRAFTER_DESIGN.md
 * §11.1). Deliberately minimal: publishing is not what the channel drafter
 * is for.
 *
 * THE FEATURE IS DARK UNTIL `toolName` AND `textArgument` ARE FILLED IN.
 * Hootsuite does not publish its MCP tool names or arguments, and its server
 * will not describe itself without a signed-in session, so they are not
 * guessed here. Someone with Hootsuite access reads them once from
 * Settings → Connectors → Hootsuite Perch (the app lists a connector's
 * tools) and fills in the three strings below.
 *
 * PREFER THE TOOL THAT SAVES A DRAFT. A draft is reviewed and sent from
 * inside Hootsuite by a person; a tool that publishes immediately makes this
 * button irreversible. The interface says "Send to Hootsuite" for that
 * reason: what happens next is Hootsuite's, and depends on the tool named
 * here.
 *
 * Who may use it is NOT configured here. It is default deny through access
 * rules (`publish::*`, `publish::<channel id>`), edited by global admins
 * under Admin → Channels.
 */
export interface HootsuitePublishingConfig {
  /** Catalog key of the connector to send through. */
  catalogKey: string;
  /** Exact MCP tool name. Empty = the feature is off. */
  toolName: string;
  /** The tool argument that takes the post's text. Empty = off. */
  textArgument: string;
  /**
   * The tool argument that takes the Hootsuite social profile a channel
   * posts to, when the tool needs one. The value comes from the channel's
   * `publishTarget`, set under Admin → Channels. Empty = not sent.
   */
  targetArgument: string;
  /** When true `targetArgument` is sent as a one-element array. */
  targetIsList: boolean;
  /** Arguments sent on every call, e.g. a "save as draft" flag. */
  fixedArguments: Record<string, string | number | boolean>;
  /** Whether a post resting on a vouched (unsourced) item may be sent. */
  allowVouched: boolean;
}

export const HOOTSUITE_PUBLISHING: HootsuitePublishingConfig = {
  catalogKey: 'hootsuitePerch',
  toolName: '',
  textArgument: '',
  targetArgument: '',
  targetIsList: false,
  fixedArguments: {},
  allowVouched: false,
};

export function isPublishingConfigured(
  config: HootsuitePublishingConfig = HOOTSUITE_PUBLISHING,
): boolean {
  return config.toolName.trim() !== '' && config.textArgument.trim() !== '';
}
