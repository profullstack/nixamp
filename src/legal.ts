/**
 * /privacy and /terms for nixamp.com and backtoschool.help, rendered on the
 * server so a crawler, a directory reviewer and curl all read the same page.
 *
 * Both sites run in this one process (backtoschool.help is a web site served
 * under its own Host, see web-sites.ts), share one set of accounts, and are
 * operated by Profullstack, so each gets its own pages describing that site.
 * A self-hosted nixamp serving its own files on its own host never answers
 * these paths: the operator of that box is not us.
 */

export type LegalKind = "privacy" | "terms";
export type LegalSite = "nixamp" | "school";

const EFFECTIVE = "November 11, 2026";
const CONTACT = "support@profullstack.com";
const OPERATOR = "Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA";

export function isLegalPath(path: string): LegalKind | null {
  if (path === "/privacy" || path === "/privacy/") return "privacy";
  if (path === "/terms" || path === "/terms/") return "terms";
  return null;
}

const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

function nixampPrivacy(): string {
  return `
<p>nixamp.com ("nixamp") is operated by ${OPERATOR}. This policy covers the nixamp.com website and apps (player, radio, music store, stations directory), its API and MCP server, and what the nixamp CLI, TUI and desktop app send to nixamp.com. It describes only what the service actually collects. backtoschool.help, which shares nixamp accounts, has <a href="https://backtoschool.help/privacy">its own policy</a>.</p>

<h2>Your own server stays yours</h2>
<p>The player and <code>nixamp serve</code> run on your own machine. Your music and video files, your library and playlists stay there and are not uploaded to us. Your machine sends something to nixamp.com only when you use a nixamp.com feature: signing in, publishing a station to the public directory, a live room's chat, transcription, or the other features below. To find a share link's address, <code>nixamp serve</code> asks ipinfo.io for the machine's public IP address unless you pass <code>--no-lookup</code>.</p>

<h2>What we collect</h2>
<p><b>Account.</b> Your email address and a password, which is stored only as a hash. You can also sign in with CoinPay, in which case we keep the CoinPay account identifier and the email it reports, linked to your account. The CLI, desktop and TV apps sign in through a device code and keep a token; tokens and sessions are stored as hashes, with a name and expiry.</p>
<p><b>Profile.</b> The public handle you choose, an optional voice for the party line, and an optional <a href="https://logicsrc.com/openprofile">OpenProfile</a> address if you link one.</p>
<p><b>What you do while signed in.</b> Artists and broadcasters you follow, favorites, saved layouts and settings you sync, watch parties you host, stations you publish, transcripts you make, and your notification choices: browser push subscriptions, whether you want email, and a phone number if you ask for text messages.</p>
<p><b>Chat.</b> A line you send to a live room's chat (the trollbox) is signed with your public handle, never your email address, and is public record: it stays in that room and there is no way to remove it. Please do not post anything you would not want public.</p>
<p><b>Speech and translation.</b> Audio you send for transcription and text you send for translation are processed on our own servers with open models; nothing is sent to a speech or translation vendor.</p>
<p><b>Purchases.</b> Songs, albums, licences and support payments are paid in cryptocurrency through CoinPay. We keep the email address you give at checkout (to send the download or licence), what was bought, the amount, and the payment reference and status. We never see card or bank details. Busy streams can ask for a small payment over x402 to keep listening.</p>

<h2>Cookies and local storage</h2>
<p>Signing in keeps a session token in your browser. A share link from someone's own server sets a cookie holding that server's key so the page can keep playing. Player settings are kept in your browser's local storage. There are no advertising cookies.</p>

<h2>Who else is involved</h2>
<ul>
<li><b>CrawlProof</b> (crawlproof.com): a stats script on the home page, for aggregate page analytics.</li>
<li><b>jsDelivr</b>: serves the WebMCP script and the shared Profullstack footer script. The newsletter form in that footer sends the address you type to pit.world, and only if you submit it.</li>
<li><b>Resend</b>: delivers password resets, receipts, licences, invitations and live notifications, so it processes your email address.</li>
<li><b>Telnyx</b>: sends text messages to the number you gave, if you turned texts on, and carries the party line's phone calls.</li>
<li><b>CoinPay</b> (coinpayportal.com): payments and the optional Sign in with CoinPay.</li>
<li><b>AI providers</b>: the AI radio station and label write and voice their own songs and breaks with c0mpute and, depending on configuration, ElevenLabs, Google Gemini, OpenAI, Anthropic and fal.ai. That work uses our prompts, not your data.</li>
<li><b>Other servers</b>: playing a station or a share link from someone else's nixamp server is a request from your browser to that server, which sees it the way any visit would.</li>
</ul>
<p>Nothing is sold, and no advertising profile is built from you.</p>

<h2>What is public</h2>
<p>Your handle, chat lines and stations you publish to the directory are public. Your email address, phone number, purchases and private settings are not.</p>

<h2>AI agents and MCP</h2>
<p>nixamp's MCP server has two endpoints (JSON-RPC 2.0, streamable HTTP). <code>https://nixamp.com/mcp/public</code> needs no account and offers only public, read-mostly tools: list the stations on every nixamp server, find one, and share a track to a station's server. <code>https://nixamp.com/mcp</code> needs a nixamp token or an OAuth 2.1 access token as a Bearer token, and then acts on your account: watch parties, transcripts, translation, chat, your profile and voice, the music catalog and your purchases, managing your own stations, your library and playlists, and backtoschool.help classes. The same tools run locally over stdio with the nixamp CLI.</p>
<p>MCP and API requests are logged (time, tool or route, IP address, and the account or key if any) for abuse prevention and rate limiting. No MCP data is sold or used for advertising.</p>

<h2>Keeping and deleting data</h2>
<p>Password reset links expire. Account data is kept until you delete it or ask us to. To delete your account, write to ${mail} from the address on the account. Chat lines are public record and are not removed.</p>

<h2>Your rights</h2>
<p>Depending on where you live, you may have the right to access, correct, delete or export your personal data. Contact us to exercise them.</p>

<h2>Children</h2>
<p>nixamp is not directed at children under 13, and we do not knowingly collect personal information from them.</p>

<h2>Changes</h2>
<p>If the service starts doing something different, this page changes with it. Material changes will be announced on this page.</p>

<h2>Contact</h2>
<p>${OPERATOR}. Email ${mail}.</p>`;
}

function nixampTerms(): string {
  return `
<h2>1. Acceptance of terms</h2>
<p>By accessing or using nixamp.com, its apps, API, CLI, desktop app or MCP server (the "Service"), you agree to these Terms of Service. If you do not agree, do not use the Service. The Service is operated by ${OPERATOR}.</p>

<h2>2. Use of the Service</h2>
<p>nixamp plays, streams and shares audio and video, lists public stations and sells the AI label's music. Only stream, publish or share what you have the right to. Do not use the Service to harass anyone, to post illegal content in chat, or to get around a station's or server's access controls. Please do not send automated traffic heavy enough to degrade the Service for anyone else.</p>

<h2>3. Accounts</h2>
<p>You are responsible for your account, your tokens and OAuth grants, and all activity under them. Tell us at once about any unauthorized use.</p>

<h2>4. Payments</h2>
<p>Purchases (songs, albums, licences, support payments, and x402 listening passes) are paid in cryptocurrency through CoinPay. A music licence grants only the uses its tier describes on the licence page.</p>

<h2>5. Your content</h2>
<p>You keep whatever rights you have in what you stream, publish or post, and you confirm you may share it. You give us permission to store, process and show it as needed to run the Service. Chat lines are public and permanent.</p>

<h2>6. MCP and API use</h2>
<p>The MCP endpoints at <code>https://nixamp.com/mcp</code> and <code>https://nixamp.com/mcp/public</code> and the REST API are part of the Service and fall under these terms, including the acceptable use rules above. An agent acting with your token acts on your behalf, and you are responsible for what it does. Do not try to get around rate limits or access controls.</p>

<h2>7. Intellectual property</h2>
<p>All content, code and trademarks associated with nixamp are the property of Profullstack, Inc. or its licensors. nixamp's source code is available under the MIT License, and open-source components are governed by their respective licenses. Music on other people's stations belongs to its owners.</p>

<h2>8. Disclaimer of warranties</h2>
<p>The Service is provided "as is" without warranties of any kind. We do not guarantee that it will be uninterrupted, secure or error-free, or that any station will keep playing.</p>

<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any indirect, incidental, special, consequential or punitive damages arising out of your use of the Service.</p>

<h2>10. Changes to terms</h2>
<p>We may update these terms from time to time. Continued use of the Service after a change means you accept the revised terms.</p>

<h2>11. Contact</h2>
<p>Questions about these terms? Email ${mail}.</p>`;
}

function schoolPrivacy(): string {
  return `
<p>BackToSchool.help is operated by ${OPERATOR}. It is a place for live classes: a host puts a broadcast (a nixamp station, a Pairux screen share or a video link) on the air, and people watch, chat and raise a hand. This policy covers the website, its API and its MCP server, and describes only what the site actually collects.</p>

<h2>Watching needs nothing</h2>
<p>Watching a public class needs no account and no cookie from us. The class's video or audio is loaded by your browser from wherever the host's broadcast lives (a nixamp server, pairux.com, or another HTTPS address), which sees that request the way any visit would.</p>

<h2>What an account stores</h2>
<p>Accounts are nixamp accounts, shared with nixamp.com. To chat, raise a hand, follow a host or teach, you sign in with an email address and password (stored only as a hash) or with CoinPay. Hosts can add a public profile: a name, a homepage, a short bio and a photo (uploaded or linked), or fill it from an OpenProfile address.</p>
<p><b>Classes.</b> For a class a host creates: its title, description, topic, schedule, visibility, broadcast link and settings. Hosts can invite people by account or by email address; the address is kept with the invitation.</p>
<p><b>Chat and raised hands.</b> A chat message is stored with the class, your account and the display name shown with it. A raised hand is stored with your account, display name and its state. Others in the class see your display name and messages.</p>
<p><b>Following and notifications.</b> The hosts you follow and, if you allow them, browser push subscriptions so you hear when a class goes live.</p>
<p><b>Connecting nixamp.</b> A host may optionally connect a nixamp account to pick one of their own live streams when going live.</p>
<p>BackToSchool.help does not ask for a birth date, school, grade, or any student record, and does not collect information about students beyond the account, chat and hand-raise data above.</p>

<h2>Write with AI</h2>
<p>If a host clicks "Write with AI" when making a class, the title, description, topic, host name, time and duration they typed are sent to an AI model to draft a description: c0mpute first and, depending on configuration, OpenAI or Anthropic. Nothing is sent unless the host asks.</p>

<h2>Cookies and local storage</h2>
<p>Signing in keeps a session token in your browser. There are no advertising cookies.</p>

<h2>Who else is involved</h2>
<ul>
<li><b>CrawlProof</b> (crawlproof.com): a stats script for aggregate page analytics.</li>
<li><b>nixamp.com</b>: accounts, sign-in and OAuth, run by us on the same service.</li>
<li><b>Resend</b>: delivers password reset email and class invitations sent to an email address, so it processes that address.</li>
<li><b>CoinPay</b> (coinpayportal.com): the optional Sign in with CoinPay.</li>
<li><b>The host's broadcast</b>: pairux.com, a nixamp server or another address the host chose, loaded by your browser.</li>
</ul>
<p>Nothing is sold, and no advertising profile is built from you.</p>

<h2>What is public</h2>
<p>Public classes, their hosts' profiles, and the chat and raised hands inside a class are visible to people in it. Unlisted and private classes are shown only to people with the link, an invitation or access.</p>

<h2>AI agents and MCP</h2>
<p>BackToSchool.help has two MCP endpoints (JSON-RPC 2.0, streamable HTTP). <code>https://backtoschool.help/mcp/public</code> needs no account and is read-only: list classes and read one. <code>https://backtoschool.help/mcp</code> needs a nixamp token or an OAuth 2.1 access token (nixamp.com is the authorization server) as a Bearer token, and then acts for that host: create, update, start, end and delete their own classes, and check whether their live broadcasts still play.</p>
<p>MCP and API requests are logged (time, tool or route, IP address, and the account or key if any) for abuse prevention and rate limiting. No MCP data is sold or used for advertising.</p>

<h2>Keeping and deleting data</h2>
<p>A host can delete a class, which deletes its chat and raised hands. Everything else is kept until you delete it or ask us to. To delete your account, write to ${mail} from the address on the account.</p>

<h2>Your rights</h2>
<p>Depending on where you live, you may have the right to access, correct, delete or export your personal data. Contact us to exercise them.</p>

<h2>Children</h2>
<p>BackToSchool.help is a general audience site for live classes; it is not directed at children under 13, and we do not knowingly collect personal information from them. Watching a public class needs no account. A child under 13 should not create an account; a teacher or parent who wants to use a class with younger children should host it and let them watch without signing in. If you believe a child under 13 has given us personal information, write to ${mail} and we will delete it.</p>

<h2>Changes</h2>
<p>If the site starts doing something different, this page changes with it. Material changes will be announced on this page.</p>

<h2>Contact</h2>
<p>${OPERATOR}. Email ${mail}.</p>`;
}

function schoolTerms(): string {
  return `
<h2>1. Acceptance of terms</h2>
<p>By accessing or using BackToSchool.help, its API or MCP server (the "Service"), you agree to these Terms of Service. If you do not agree, do not use the Service. The Service is operated by ${OPERATOR}.</p>

<h2>2. Use of the Service</h2>
<p>BackToSchool.help lists and hosts live classes around a broadcast the host provides. Hosts may only broadcast what they have the right to. Do not use classes or chat to harass anyone, to post illegal content, or to collect other people's personal information. Please do not send automated traffic heavy enough to degrade the Service for anyone else.</p>

<h2>3. Accounts</h2>
<p>Accounts are nixamp accounts. You are responsible for your account, your tokens and OAuth grants, and all activity under them. Tell us at once about any unauthorized use. People under 13 should watch without an account.</p>

<h2>4. Your content</h2>
<p>You keep whatever rights you have in your classes, profile and messages, and you confirm you may share them. You give us permission to store, process and show them as needed to run the Service. A host is responsible for their class and what it broadcasts.</p>

<h2>5. MCP and API use</h2>
<p>The MCP endpoints at <code>https://backtoschool.help/mcp</code> and <code>https://backtoschool.help/mcp/public</code> and the API are part of the Service and fall under these terms, including the acceptable use rules above. An agent acting with your token acts on your behalf, and you are responsible for what it does.</p>

<h2>6. Intellectual property</h2>
<p>All content, code and trademarks associated with BackToSchool.help and nixamp are the property of Profullstack, Inc. or its licensors. Open-source components are governed by their respective licenses. Classes and broadcasts belong to their hosts.</p>

<h2>7. Disclaimer of warranties</h2>
<p>The Service is provided "as is" without warranties of any kind. We do not guarantee that it will be uninterrupted, secure or error-free, or that any class will take place. Classes are given by their hosts; nothing here is an endorsement of what they teach.</p>

<h2>8. Limitation of liability</h2>
<p>To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any indirect, incidental, special, consequential or punitive damages arising out of your use of the Service.</p>

<h2>9. Changes to terms</h2>
<p>We may update these terms from time to time. Continued use of the Service after a change means you accept the revised terms.</p>

<h2>10. Contact</h2>
<p>Questions about these terms? Email ${mail}.</p>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8eaed;--muted:#9aa0a6;--link:#7cc4ff;--line:#2a2f36}
@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#1b1f24;--muted:#5f6368;--link:#0b62c4;--line:#e3e6ea}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--link)}header,main,footer.legal-footer{max-width:760px;margin:0 auto;padding:16px}
header{display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line)}
header .brand{font-weight:700;text-decoration:none;color:var(--fg)}
h1{font-size:2rem;margin:24px 0 4px}h2{font-size:1.2rem;margin:28px 0 8px}.effective{color:var(--muted);margin:0 0 16px}
code{font-size:.9em;word-break:break-all}ul{padding-left:20px}
footer.legal-footer{border-top:1px solid var(--line);color:var(--muted);display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}`;

/** One whole page. `site` is the origin it is served under (canonical link). */
export function legalPage(kind: LegalKind, which: LegalSite, site: string): string {
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Service";
  const name = which === "school" ? "BackToSchool.help" : "nixamp";
  const body = which === "school"
    ? (kind === "privacy" ? schoolPrivacy() : schoolTerms())
    : (kind === "privacy" ? nixampPrivacy() : nixampTerms());
  const other = kind === "privacy" ? `<a href="/terms">Terms of Service</a>` : `<a href="/privacy">Privacy Policy</a>`;
  const footer = which === "school"
    ? `<footer class="legal-footer"><span>Powered by <a href="https://nixamp.com">NixAmp</a></span><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>`
    : `<footer class="legal-footer"><a href="/">nixamp</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>`;
  const origin = site.replace(/\/$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${name}</title>
<meta name="description" content="${title} for ${name}.">
<link rel="canonical" href="${origin}/${kind}">
<style>${STYLE}</style>
</head>
<body>
<header><a class="brand" href="/">${name}</a><nav>${other}</nav></header>
<main>
<h1>${title}</h1>
<p class="effective">Effective date: ${EFFECTIVE}</p>
${body}
</main>
${footer}
</body>
</html>`;
}
