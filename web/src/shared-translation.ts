import { SharedAudio as Base } from "@profullstack/live-translate/browser";

/** nixamp's route and the `nixamp-shared:` clip URLs app.ts routes to it. */
export class SharedAudio extends Base {
  constructor(options: ConstructorParameters<typeof Base>[0]) { super({ path: "/api/v1/speech/shared", scheme: "nixamp-shared", ...options }); }
}
