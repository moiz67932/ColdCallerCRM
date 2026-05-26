export type NormalizedPayTokenRouteParam = {
  token: string;
  placeholderPrefixStripped: boolean;
  prefixVariant: "decoded" | "encoded" | null;
};

export function normalizePayTokenRouteParam(rawToken: string): NormalizedPayTokenRouteParam {
  const rawPlaceholderPrefix = "%7B%7B1%7D%7D";

  if (rawToken.startsWith(rawPlaceholderPrefix)) {
    return {
      token: rawToken.slice(rawPlaceholderPrefix.length),
      placeholderPrefixStripped: true,
      prefixVariant: "encoded",
    };
  }

  const decodedToken = safeDecodeURIComponent(rawToken);
  const decodedPlaceholderPrefix = "{{1}}";

  // Compatibility fallback for older WhatsApp template URL prefixes.
  if (decodedToken.startsWith(decodedPlaceholderPrefix)) {
    return {
      token: decodedToken.slice(decodedPlaceholderPrefix.length),
      placeholderPrefixStripped: true,
      prefixVariant: "decoded",
    };
  }

  return {
    token: decodedToken,
    placeholderPrefixStripped: false,
    prefixVariant: null,
  };
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
