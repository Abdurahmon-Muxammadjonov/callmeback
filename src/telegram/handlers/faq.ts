import { askQuestion } from '../aiAssistant';
import { logEvent } from '../leadsDb';
import { MAIN_MENU } from '../keyboards';
import type { SessionContext } from '../dbSession';

export async function handleFreeformQuestion(ctx: SessionContext, text: string): Promise<void> {
  await logEvent(ctx.from!.id, 'faq_question', { text });
  await ctx.sendChatAction('typing');

  try {
    const answer = await askQuestion(text);
    await ctx.reply(answer);
  } catch (e: any) {
    console.error('AI javob berishda xato:', e?.message);
    await ctx.reply(
      "Kechirasiz, hozir javob bera olmadim. 👨‍💼 Admin bilan bog'lanish tugmasini bosing yoki birozdan so'ng qayta urinib ko'ring.",
      MAIN_MENU,
    );
  }
}
