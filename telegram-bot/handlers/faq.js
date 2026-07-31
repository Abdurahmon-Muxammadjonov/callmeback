import { askQuestion } from '../aiAssistant.js';
import { logEvent } from '../db.js';
import { MAIN_MENU } from '../keyboards.js';

export async function handleFreeformQuestion(ctx, text) {
  await logEvent(ctx.from.id, 'faq_question', { text });
  await ctx.sendChatAction('typing');

  try {
    const answer = await askQuestion(text);
    await ctx.reply(answer);
  } catch (e) {
    console.error('AI javob berishda xato:', e.message);
    await ctx.reply(
      "Kechirasiz, hozir javob bera olmadim. 👨‍💼 Admin bilan bog'lanish tugmasini bosing yoki birozdan so'ng qayta urinib ko'ring.",
      MAIN_MENU,
    );
  }
}
