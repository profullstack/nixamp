/** Prepaid translation credit, from @profullstack/live-translate, sold as nixamp. */
import { TranslationPasses as Base } from "@profullstack/live-translate";
export { TRANSLATION_MULTIPLIER, TRANSLATION_PLANS, translationCost, verifyTranslationPayment, coinpayKeyFrom, verifyCoinpaySignature, readCoinpayWebhook,
  type TranslationPlan, type TranslationUsage, type TranslationMeter, type TranslationAccess } from "@profullstack/live-translate";

export class TranslationPasses extends Base {
  constructor(options: ConstructorParameters<typeof Base>[0]) { super({ app: "nixamp", label: "Nixamp translated audio", ...options }); }
}
