import { Router, Response } from 'express';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { askAssistant, type ChatMsg } from '../lib/assistant';

// ============================================================================
// POST /api/assistant/ask — AI yordamchi (lib/assistant.ts). Body:
// { messages: [{ role: 'user'|'assistant', content }] } — oxirgisi savol.
// Faqat direktor/admin (kompaniya bo'yicha ma'lumot); kompaniya — tokendan.
// ============================================================================

const router = Router();
router.use(requireAuth, requireCompanyRole(['director', 'admin']));

router.post('/ask', async (req: CompanyAuthedRequest, res: Response) => {
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const history: ChatMsg[] = raw
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ success: false, error: 'Savol yozing.' });
  }
  const lang = String(req.headers['accept-language'] ?? 'uz').slice(0, 2);
  try {
    const answer = await askAssistant(req.auth!.companyId as string, history, lang);
    return res.status(200).json({ success: true, data: { answer } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'AI javob bermadi.' });
  }
});

export default router;
