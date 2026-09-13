export interface MailSender { apiKey: string; from: string }
export interface BrandedMailSender extends MailSender { backtoschool?: MailSender }

/** Only the exact school origins select its verified sender and credentials. */
export function mailSender(options: BrandedMailSender, link: string): MailSender {
  try {
    const url = new URL(link);
    if (options.backtoschool && url.protocol === "https:" &&
      ["backtoschool.help", "www.backtoschool.help"].includes(url.hostname)) return options.backtoschool;
  } catch { /* A malformed link never changes the sender. */ }
  return options;
}
