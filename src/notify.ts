/**
 * Telling followers a broadcaster went live, wherever they are.
 *
 * Three channels, because "any device" is not one thing. A browser that has
 * granted permission gets a push -- which is also how the desktop app and a
 * phone with the PWA installed hear about it, since all three are the same
 * subscription under different chrome. An inbox gets mail. A handset that gave
 * us a number gets a text.
 *
 * Every channel is optional at both ends. The operator may configure none of
 * them, in which case nothing is sent and nothing throws; and a follower may
 * want mail but not texts, which is the default because a text is the most
 * intrusive of the three and the one you should have to ask for.
 *
 * Nothing here retries. A missed "so-and-so is live" is worth very little an
 * hour later, and a retry queue for a message with that shelf life is machinery
 * that will outlive its usefulness. What it does do is notice a push endpoint
 * the browser vendor has retired, and say so, so the row can be dropped rather
 * than pushed at forever.
 */
import type { PushTarget, Reachable } from "./follows.ts";
import type { Sms } from "./partyline.ts";

export interface Notification {
  /** "Chovy is live" */
  title: string;
  /** "Playing Top Gun: Maverick. Call 408-357-2326 and key 482917." */
  body: string;
  /** Where a click should land. */
  url: string;
}

/** What happened to one push. `gone` means the subscription should be dropped. */
export type PushResult = "sent" | "gone" | "failed";

export interface NotifyChannels {
  email?: (to: string, note: Notification) => Promise<boolean>;
  sms?: Sms;
  push?: (target: PushTarget, note: Notification) => Promise<PushResult>;
  /** Called with an endpoint the vendor has retired, so it can be forgotten. */
  onGone?: (endpoint: string) => Promise<void>;
  onEvent?: (message: string) => void;
}

export interface NotifyReport {
  email: number;
  sms: number;
  push: number;
  dropped: number;
}

/**
 * Tell an audience, on every channel each of them wants.
 *
 * Sent in parallel across people and channels. A thousand followers is a
 * thousand independent HTTP calls, and doing them in sequence would mean the
 * last person hears about a stream that has already finished.
 */
export async function notifyAll(
  audience: readonly Reachable[],
  note: Notification,
  channels: NotifyChannels,
): Promise<NotifyReport> {
  const report: NotifyReport = { email: 0, sms: 0, push: 0, dropped: 0 };
  const gone: string[] = [];

  const jobs: Promise<void>[] = [];
  for (const person of audience) {
    if (person.wantsEmail && person.email && channels.email) {
      jobs.push(
        channels.email(person.email, note).then((ok) => {
          if (ok) report.email += 1;
        }),
      );
    }

    if (person.wantsSms && person.phone && channels.sms) {
      // The text carries the same words, plus how to stop getting them --
      // which is not optional on an automated message to a US number.
      const text = `${note.title}. ${note.body} Reply STOP to opt out.`;
      jobs.push(
        channels.sms.send(person.phone, text).then((ok) => {
          if (ok) report.sms += 1;
        }),
      );
    }

    if (person.wantsWeb && channels.push) {
      for (const target of person.push) {
        jobs.push(
          channels.push(target, note).then((result) => {
            if (result === "sent") report.push += 1;
            else if (result === "gone") gone.push(target.endpoint);
          }),
        );
      }
    }
  }

  // allSettled, not all: one bad address must not cancel everybody else's.
  await Promise.allSettled(jobs);

  if (channels.onGone) {
    await Promise.allSettled(gone.map((endpoint) => channels.onGone!(endpoint)));
    report.dropped = gone.length;
  }

  channels.onEvent?.(
    `  told followers: ${report.push} push, ${report.email} email, ${report.sms} sms` +
      (report.dropped ? `, dropped ${report.dropped} dead subscription(s)` : ""),
  );
  return report;
}

/**
 * Mail, over Resend's HTTP API.
 *
 * HTTP rather than SMTP so there is no connection to hold, no port to be
 * blocked, and no dependency: a fetch is the whole client.
 */
export function resendEmail(
  { apiKey, from, fetch = globalThis.fetch, onEvent }: {
    apiKey: string;
    from: string;
    fetch?: typeof globalThis.fetch;
    onEvent?: (message: string) => void;
  },
): (to: string, note: Notification) => Promise<boolean> {
  return async (to, note) => {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          subject: note.title,
          text: `${note.body}\n\n${note.url}\n\nYou are getting this because you follow them on nixamp.`,
          html:
            `<p>${escapeHtml(note.body)}</p>` +
            `<p><a href="${escapeHtml(note.url)}">${escapeHtml(note.url)}</a></p>` +
            `<p style="color:#666;font-size:12px">You are getting this because you follow them on nixamp.</p>`,
        }),
      });
      if (!response.ok) {
        onEvent?.(`  email to ${to} -> ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      onEvent?.(`  email to ${to} failed: ${(error as Error).message}`);
      return false;
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Web push, to a browser, a desktop app or an installed PWA.
 *
 * The library is imported lazily because it is only needed on the instance
 * that has VAPID keys -- which is nixamp.com and nowhere else. A laptop
 * running `nixamp serve` should not pay to load it.
 *
 * 404 and 410 mean the vendor has retired the subscription. That is not a
 * failure to retry; it is a row to delete.
 */
export function webPush(
  { publicKey, privateKey, subject, onEvent }: {
    publicKey: string;
    privateKey: string;
    /** A mailto: or https: URL identifying us to the push service. */
    subject: string;
    onEvent?: (message: string) => void;
  },
): (target: PushTarget, note: Notification) => Promise<PushResult> {
  let library: Promise<{ sendNotification: Function; setVapidDetails: Function }> | null = null;

  const load = async () => {
    library ??= import("web-push").then((mod) => {
      const wp = ((mod as Record<string, unknown>)["default"] ?? mod) as {
        sendNotification: Function;
        setVapidDetails: Function;
      };
      wp.setVapidDetails(subject, publicKey, privateKey);
      return wp;
    });
    return library;
  };

  return async (target, note) => {
    try {
      const wp = await load();
      await wp.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify({ title: note.title, body: note.body, url: note.url }),
        { TTL: 60 * 30 },
      );
      return "sent";
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        onEvent?.(`  push endpoint retired by the vendor, dropping it`);
        return "gone";
      }
      onEvent?.(`  push failed: ${status ?? (error as Error).message}`);
      return "failed";
    }
  };
}
