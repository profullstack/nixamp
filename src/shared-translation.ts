/** Shared live translation, from @profullstack/live-translate, limited to nixamp channels. */
import { SharedTranslations as Base, liveInput as baseLiveInput, SpeechError, type OpenLiveInput } from "@profullstack/live-translate";
export { publicStreamAddress, type LiveInput, type OpenLiveInput, type SharedEvent } from "@profullstack/live-translate";

/** Only a live nixamp channel (`/api/channels/<id>`, optionally `?k=`). */
export function sharedSource(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SpeechError("Choose a live Nixamp channel.", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !/^\/api\/channels\/[\w-]{1,80}$/.test(url.pathname) || [...url.searchParams.keys()].some(key => key !== "k")) throw new SpeechError("Choose a live Nixamp channel.", 400);
  if (url.toString().length > 2048) throw new SpeechError("Invalid live source.", 400);
  url.searchParams.sort(); return url;
}
export function liveInput(ffmpeg: string[] = ["ffmpeg"]): OpenLiveInput { return baseLiveInput(ffmpeg, "Nixamp shared translated audio"); }

export class SharedTranslations extends Base {
  constructor(options: ConstructorParameters<typeof Base>[0]) { super({ parse: sharedSource, open: liveInput(), ...options }); }
}
