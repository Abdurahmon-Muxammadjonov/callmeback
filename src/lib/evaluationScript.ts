// QO'NG'IROQ BAHOLASH SKRIPTI (o'quv markazi uchun).
//
// Foydalanuvchi talabi (2026-09-23): "o'zingdan skript yozib tur va usha
// skript bo'yicha tahrirlasin GPT, xodimga 10.0 ballik sistemada baholasin".
//
// Bu — sotuv qo'ng'irog'ining bosqichma-bosqich standarti. AI har bir
// qo'ng'iroqni SHU bandlar bo'yicha tekshiradi va ball qo'yadi. Ball
// ekranda 10 ballik ko'rinishda chiqadi (ichkarida 0-100 bo'lib saqlanadi:
// 8.5/10 = 85).
//
// MUHIM: kompaniya o'z mezonlarini qo'shsa (Mezonlar bo'limi), ular SHU
// skript USTIGA qo'shiladi — ya'ni bu standart asos bo'lib qoladi, mijoz
// esa o'ziga xos talablarini alohida qo'shadi.

export interface ScriptStage {
  key: string;
  title: string;
  points: number;      // 100 ballik ichidagi ulushi (10 ballikda: points/10)
  checks: string[];    // AI nimaga qarab ball qo'yadi
}

export const CALL_SCRIPT: ScriptStage[] = [
  {
    key: 'salomlashish',
    title: 'Salomlashish va tanishtirish',
    points: 10,
    checks: [
      'Xushmuomala salomlashdi',
      'O\'z ismini aytdi',
      'Qaysi o\'quv markazidan ekanini aytdi',
      'Mijozning ismini so\'radi yoki ishlatdi',
    ],
  },
  {
    key: 'ehtiyoj',
    title: 'Ehtiyojni aniqlash',
    points: 25,
    checks: [
      'Mijoz nima maqsadda murojaat qilganini so\'radi (qaysi kurs, kim uchun)',
      'Ochiq savollar berdi (ha/yo\'q emas)',
      'Mijozning darajasi/tayyorgarligi yoki maqsadi (imtihon, muddat) aniqlandi',
      'Mijozni bo\'lmasdan tingladi',
    ],
  },
  {
    key: 'taqdimot',
    title: 'Kurs va narxni taqdim etish',
    points: 20,
    checks: [
      'Mijoz ehtiyojiga MOS kursni taklif qildi',
      'Dars jadvali/davomiyligi haqida aniq ma\'lumot berdi',
      'Narxni aniq aytdi (yashirmadi, "keling gaplashamiz" bilan qochmadi)',
      'Markazning kuchli tomonini (natija, o\'qituvchi, kafolat) aytdi',
    ],
  },
  {
    key: 'etiroz',
    title: 'E\'tiroz bilan ishlash',
    points: 20,
    checks: [
      'Mijozning shubhasi/e\'tirozini (qimmat, vaqtim yo\'q, o\'ylab ko\'raman) inobatga oldi',
      'Javobni dalil bilan berdi, bahslashmadi',
      'E\'tirozdan keyin suhbatni davom ettirdi, taslim bo\'lmadi',
      'E\'tiroz bo\'lmagan bo\'lsa — bu band to\'liq hisoblanadi',
    ],
  },
  {
    key: 'keyingi_qadam',
    title: 'Keyingi qadamni belgilash',
    points: 15,
    checks: [
      'Mijozni markazga taklif qildi (sinov darsi, tashrif) YOKI aniq qayta aloqa vaqtini kelishdi',
      'Kelishuv aniq: sana/vaqt aytildi',
      'Mijozning aloqa ma\'lumotini oldi yoki tasdiqladi',
    ],
  },
  {
    key: 'madaniyat',
    title: 'Muloqot madaniyati',
    points: 10,
    checks: [
      'Ohang xushmuomala va ishonchli',
      'Nutq aniq, qo\'pol yoki loqayd so\'zlar yo\'q',
      'Mijozning gapini bo\'lmadi',
      'Suhbatni chiroyli yakunladi (xayrlashdi, minnatdorchilik bildirdi)',
    ],
  },
];

// Promptga qo'shiladigan matn.
export function buildScriptRules(): string {
  const lines: string[] = [
    'BAHOLASH SKRIPTI — har bir qo\'ng\'iroqni AYNAN shu bandlar bo\'yicha tekshiring va ball qo\'ying.',
    'Har band uchun ichidagi tekshiruvlar qancha bajarilganiga qarab shu banddan ball bering (qisman bajarilsa — qisman ball).',
    '',
  ];
  for (const st of CALL_SCRIPT) {
    lines.push(`${st.title} — ${st.points} ball (10 ballikda ${(st.points / 10).toFixed(1)}):`);
    for (const c of st.checks) lines.push(`   - ${c}`);
    lines.push('');
  }
  lines.push(
    'kpi_score — shu bandlar ballarining YIG\'INDISI (0-100).',
    'criteria_scores massivini SHU bandlar bilan to\'ldiring: har band uchun {title: band nomi, category: "Skript", score: 0-100 (o\'sha band necha foiz bajarilgani)}.',
    'Qo\'ng\'iroq javobsiz qolgan yoki suhbat umuman bo\'lmagan bo\'lsa — kpi_score 0 va criteria_scores bo\'sh massiv.',
  );
  return lines.join('\n');
}
