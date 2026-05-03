const defaultScripts = {
  opening:
    "Hi {{contactName}}, this is {{businessName}} outreach from a local growth team serving {{city}}, {{state}}.",
  gatekeeper:
    "Thanks for taking my call. Who is best to speak with about growth for a {{niche}} business?",
  voicemail:
    "Hi {{contactName}}, this is a quick note for {{businessName}} in {{city}}. Please call me back when you have a minute.",
  callbackConfirmation:
    "Perfect, I will call back at the agreed time. Thanks again for your time today.",
  close:
    "Thanks for the conversation today. I will send a short follow-up and next steps.",
};

export type ScriptTemplates = typeof defaultScripts;

export function getDefaultScripts(): ScriptTemplates {
  return defaultScripts;
}

export function applyTemplateVariables(template: string, variables: Record<string, string | null | undefined>) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const value = variables[key];
    return value ? value : "";
  });
}
