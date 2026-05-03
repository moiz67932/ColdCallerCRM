import sanitizeHtml from "sanitize-html";

export function sanitizeUserText(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  }).trim();
}
