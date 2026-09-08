/**
 * The page that explains the text messages.
 *
 * Not decoration and not marketing. A carrier reviewing a toll-free number for
 * A2P messaging asks to see where the consent comes from, and answers "a
 * screenshot" -- which is awkward when the consent is somebody pressing 1 on a
 * telephone and there is no screen to shoot. This page is that evidence: the
 * exact prompt the caller hears, what they get, how often, and how to stop.
 *
 * It is also the honest thing to publish regardless of who is asking. Anyone
 * who gets a text from us can find out here why, and stop it, without having
 * to reply to a number they do not recognise.
 *
 * Served as a page of its own rather than a route in the app, because it has
 * to be readable by someone with no JavaScript and no account -- a reviewer,
 * or a person holding a phone that just buzzed.
 */

export const OPT_IN_PATH = "/sms";

/** The number a caller dials. */
export const CALL_IN_NUMBER = "888-766-6818";

/** The number a reminder is sent from. Not the one above; see partyline.ts. */
export const SMS_FROM_NUMBER = "408-426-9127";

export function optInPage(
  { callIn = CALL_IN_NUMBER, smsFrom = SMS_FROM_NUMBER } = {},
): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream reminders by text &mdash; nixamp</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 42rem;
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .sub { opacity: .7; margin: 0 0 2rem; }
  dt { font-weight: 600; margin-top: .9rem; }
  dd { margin: .15rem 0 0; }
  ol { padding-left: 1.25rem; }
  li { margin: .4rem 0; }
  code, .n { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  blockquote {
    margin: .75rem 0; padding: .75rem 1rem; border-left: 3px solid currentColor;
    opacity: .85; font-style: italic;
  }
  footer { margin-top: 3rem; font-size: .9rem; opacity: .7; }
</style>

<h1>Stream reminders by text</h1>
<p class="sub">What these messages are, and how to stop them.</p>

<h2>How you sign up</h2>
<p>
  There is one way, and it happens on the phone. Call
  <strong class="n">${callIn}</strong> and key the six-digit code of a stream.
  If that stream has finished, you hear this:
</p>
<blockquote>
  Welcome to &lt;name&gt;&rsquo;s live stream of &lt;what they were playing&gt;.
  The live stream ended at &lt;time&gt; Pacific. Call back later when they
  stream again. Press&nbsp;1 to get a text message when they do.
</blockquote>
<ol>
  <li>You press <strong>1</strong>.</li>
  <li>We keep the number you called from, and nothing else.</li>
  <li>When that stream goes live again, you get one text.</li>
</ol>
<p>
  Pressing anything else, or hanging up, signs you up for nothing. We never add
  a number that did not press&nbsp;1 on that prompt.
</p>

<h2>What you get</h2>
<dl>
  <dt>Message</dt>
  <dd class="n">&lt;name&gt; is live now of &lt;what&gt; on nixamp. Call ${callIn} and key &lt;code&gt; to listen. Reply STOP to opt out.</dd>

  <dt>How often</dt>
  <dd>
    Once per stream you asked about. Asking is a one-time thing: after that
    text is sent you are off the list, and you would have to call and press 1
    again to be told about the next one. There is no schedule and no marketing.
  </dd>

  <dt>Sent from</dt>
  <dd class="n">${smsFrom}</dd>
</dl>

<h2>How to stop</h2>
<p>
  Reply <strong>STOP</strong> to any message and you will get no more.
  Reply <strong>HELP</strong> for help. You can also simply never press 1.
</p>
<p>Message and data rates may apply.</p>

<h2>What we keep</h2>
<p>
  The phone number you called from, tied to the stream you asked about, until
  that text is sent &mdash; then it is deleted. Nothing is sold, and nothing is
  shared with anyone but the carrier that has to deliver the message.
</p>

<footer>
  ProFullStack, Inc. &middot;
  <a href="mailto:anthony@profullstack.com">anthony@profullstack.com</a> &middot;
  <a href="/">nixamp</a>
</footer>
</html>
`;
}
