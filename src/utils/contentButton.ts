import { BE, type BtnStyle } from "./keyboard.js";

export const BUTTON_STYLES: BtnStyle[] = ["primary", "success", "danger"];

export type ButtonStyleChoice = BtnStyle | "random";

export interface ContentButton {
  buttonText?: string | null;
  buttonUrl?: string | null;
  buttonStyle?: string | null;
}

export function randomButtonStyle(): BtnStyle {
  return BUTTON_STYLES[Math.floor(Math.random() * BUTTON_STYLES.length)];
}

/** Rangni foydalanuvchiga tushunarli o'zbekcha etiketga aylantiradi */
export function buttonStyleLabel(style?: string | null): string {
  switch (style) {
    case "success":
      return "Yashil";
    case "danger":
      return "Qizil";
    case "random":
      return "Tasodifiy";
    default:
      return "Ko'k";
  }
}

export function normalizeButtonStyle(style?: string | null): BtnStyle {
  return BUTTON_STYLES.includes(style as BtnStyle) ? (style as BtnStyle) : "primary";
}

export function resolveButtonStyle(choice?: string | null): BtnStyle {
  return choice === "random" ? randomButtonStyle() : normalizeButtonStyle(choice);
}

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function contentButtonRow(item: ContentButton): any[] | null {
  const text = item.buttonText?.trim();
  const url = item.buttonUrl?.trim();
  if (!text || !url) return null;

  return [
    {
      text,
      url,
      style: normalizeButtonStyle(item.buttonStyle),
      icon_custom_emoji_id: BE.chAdd,
    },
  ];
}

export function contentButtonMarkup(
  item: ContentButton,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[][] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | undefined {
  const button = contentButtonRow(item);
  const inline_keyboard = button ? [button, ...rows] : rows;
  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
}
