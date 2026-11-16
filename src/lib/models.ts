export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/**
 * Parses `provider/model` or `provider/model#variant`. The provider is everything before the first
 * slash, so model IDs that contain slashes (`litellm/chatgpt/gpt-6.1-sol#high`) work.
 */
export function parseModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const [reference = "", variant, ...extra] = value.trim().split("#");
  const slash = reference.indexOf("/");
  if (extra.length > 0 || slash <= 0 || slash === reference.length - 1) return undefined;
  if (variant !== undefined && variant === "") return undefined;
  const ref = { providerID: reference.slice(0, slash), id: reference.slice(slash + 1) };
  return variant === undefined ? ref : { ...ref, variant };
}

export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
