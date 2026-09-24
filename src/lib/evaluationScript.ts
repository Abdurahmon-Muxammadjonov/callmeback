// SOTUV SKRIPTLARI — SAT / Universitetga tayyorlov kursi.
// Manba: kompaniyaning o'z qo'llanmalari (call center / administrator),
// foydalanuvchi bergan 2026-09-23.
//
// IKKI XIL QO'NG'IROQ, IKKI XIL SKRIPT:
//   A) YANGI LID — hozir qiziqib, ariza qoldirgan mijoz.
//   B) ESKI BAZA — 6-7 oy oldin qiziqib, yozilmay ketgan mijozni qayta
//      jonlantirish. Bu yerda POVOD (qo'ng'iroq sababi) va kontekstni
//      tiklash MAJBURIY, aks holda mijoz e'tiroz bildiradi.
//
// IKKALASIDA HAM ASOSIY QOIDA: telefonda sotilmaydi — mijoz BEPUL PROBNIY
// darsga olib kelinadi, sotuv o'sha yerda bo'ladi. Shu sabab "Probniyga
// chaqirish" har ikkala skriptda eng katta ulushga ega (2.0 / 10).
//
// AI avval qo'ng'iroq turini aniqlaydi, keyin FAQAT mos skript bo'yicha
// baholaydi. Ball ekranda 10 ballik ko'rinishda chiqadi (ichkarida 0-100).

export interface ScriptStage {
  key: string;
  title: string;
  points: number;      // 100 ballik ichidagi ulush (10 ballikda: points/10)
  checks: string[];    // AI nimaga qarab ball qo'yadi
}

// ─────────────────────────────────────────────────────────────────────────
// A) YANGI LID SKRIPTI
// ─────────────────────────────────────────────────────────────────────────
export const FRESH_LEAD_SCRIPT: ScriptStage[] = [
  {
    key: 'salomlashish',
    title: '1. Salomlashish va tasdiqlash',
    points: 8,
    checks: [
      'Salomlashdi va mijozga ismi bilan murojaat qildi',
      'O\'z ismini va akademiya nomini aytdi, konsultant ekanini bildirdi',
      'Mijoz SAT/universitetga tayyorlov bo\'yicha ro\'yxatdan o\'tganini tasdiqlatdi ("shunaqami?")',
      'Savoldan keyin PAUZA qildi — mijozning javobini kutdi, gapirib ketmadi',
    ],
  },
  {
    key: 'filtrlash',
    title: '2. Filtrlash (mos mijozmi)',
    points: 10,
    checks: [
      'So\'radi: ma\'lumot olmoqchimi yoki o\'qishni jiddiy boshlamoqchimi',
      'O\'quvchining bosqichini aniqladi (nechanchi sinf, maktabni bitiryaptimi, talabami)',
      'Maqsadli universitet/yo\'nalishni so\'radi',
      'Mos kelmaydigan mijoz bo\'lsa (maqsadsiz, byudjet yo\'q) — ehtirom bilan, vaqt sarflamasdan ajratdi',
    ],
  },
  {
    key: 'programmalashtirish',
    title: '3. Programmalashtirish (suhbat tartibi)',
    points: 7,
    checks: [
      'Suhbat qanday tartibda borishini oldindan tushuntirdi',
      'Avval ehtiyoj ko\'riladi, keyin ma\'lumot beriladi, oxirida birga qaror qilinadi — deb aytdi',
      'Ruxsat oldi: "Bo\'ladimi?" kabi kichik "ha" so\'radi',
    ],
  },
  {
    key: 'ehtiyoj',
    title: '4. Ehtiyojni aniqlash',
    points: 16,
    checks: [
      'SATga/universitetga tayyorlanishga aynan nima sabab bo\'lganini so\'radi',
      'Hozirgi ingliz tili darajasini va avvalgi tayyorgarligini so\'radi',
      'Qaysi davlat/universitetlarni ko\'zlayotganini so\'radi',
      'Muddatni so\'radi (qachongacha topshirmoqchi)',
      'KO\'PROQ TINGLADI — mijozni bo\'lmadi, javoblarini oxirigacha eshitdi',
    ],
  },
  {
    key: 'a_b',
    title: '5. A dan B nuqtaga (orzu va og\'riq)',
    points: 12,
    checks: [
      'Maqsadning sababini so\'radi: nega aynan o\'sha universitet/ball',
      'Kirsa hayotida nima o\'zgarishini so\'radi (orzuni kuchaytirdi)',
      'Kira olmasa nimani yo\'qotishini so\'radi (og\'riqni ko\'rsatdi)',
      'Hozir maqsadga chiqa olmayotganining sababini so\'radi va yechimga ko\'prik qurdi',
    ],
  },
  {
    key: 'taqdimot',
    title: '6. Taqdimot (yechim va tariflar)',
    points: 12,
    checks: [
      'Taqdimotdan oldin ruxsat oldi ("...foydalanardingizmi?" kabi kichik "ha")',
      'Modullarni aytdi: diagnostika, Reading & Writing, Math, ball strategiyasi, admission/hujjatlar, qo\'llab-quvvatlash',
      'Modullarni XUSUSIYAT emas, FOYDA tilida aytdi ("bu sizga ... beradi")',
      'Tariflarni tushuntirdi (Standart / Premium / VIP) va narxni aniq aytdi',
      'Mijoz faqat narx so\'rasa — avval kamida 3 ta ehtiyoj savolini berdi, darrov narx aytmadi',
    ],
  },
  {
    key: 'probniy',
    title: '7. Probniyga chaqirish (ASOSIY yopish)',
    points: 20,
    checks: [
      'Darajani aniqlash uchun test/diagnostika taklif qildi',
      'BEPUL probniy darsga aniq taklif qildi (asosiy maqsad shu)',
      'Aniq vaqt taklif qildi va TANLOV berdi (shanba soat 10 mi, 14 mi)',
      'Joy cheklanganini aytdi va joyni band qilishni taklif qildi ("kelishdikmi?")',
      'Yopiq kanalga qo\'shishni / lokatsiya yuborishni aytdi',
    ],
  },
  {
    key: 'etiroz',
    title: '8. E\'tirozlar bilan ishlash',
    points: 8,
    checks: [
      'FORMULA: avval qo\'shildi/tan oldi, keyin argument, keyin kichik qadam (probniy)',
      'E\'tirozni rad etmadi, bahslashmadi',
      '"Pul yo\'q / qimmat" — investitsiya, grant tejash, kunlik narx, bo\'lib to\'lash',
      '"O\'ylab ko\'raman" — nima o\'ylantirayotgani aniqlashtirildi va probniyga chaqirildi',
      '"Natija bo\'lmasachi" — real natijalar (1520, 1410) va shartnomadagi kafolat aytildi',
    ],
  },
  {
    key: 'yopish',
    title: '9. Yopish va keyingi qadam',
    points: 7,
    checks: [
      'TANLOV berdi ("Standart yoki Premium?") — "ha/yo\'q" savoli emas',
      'Joyni band qilish / oldindan to\'lov (50%) haqida aniq taklif qildi',
      'Telegram link yoki lokatsiya yuborishni aytdi',
      'Keyingi aloqa vaqtini aniq belgiladi ("ertaga soat ... da xabarlashaman")',
      'Chegirmani birinchi qurol sifatida ishlatmadi (avval qiymat orqali yopdi)',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// B) ESKI BAZANI QAYTA JONLANTIRISH SKRIPTI
//    (6-7 oy oldin qiziqib, kursga yozilmay qolgan mijozlar)
// ─────────────────────────────────────────────────────────────────────────
export const REACTIVATION_SCRIPT: ScriptStage[] = [
  {
    key: 'povod',
    title: '1. Salomlashish va POVOD (qo\'ng\'iroq sababi)',
    points: 12,
    checks: [
      'Salomlashdi, ismi bilan murojaat qildi va vaqt so\'radi ("bir-ikki daqiqa vaqtingiz bormi?")',
      'Javobni kutdi — pauza qildi',
      'O\'zini va akademiyani tanishtirdi',
      'MAJBURIY: qachon ariza qoldirganini eslatdi ("taxminan 6 oy oldin ... ro\'yxatdan o\'tgan ekansiz")',
      'POVOD aytdi: yangi guruh/oqim, yangi natijalar (1500+ ball), muddat yaqinlashgani yoki eski arizachilarga bepul probniy. POVODSIZ qo\'ng\'iroq — bu band bajarilmagan hisoblanadi',
    ],
  },
  {
    key: 'kontekst',
    title: '2. Kontekstni tiklash (xotirani jonlantirish)',
    points: 10,
    checks: [
      'O\'shanda nima so\'raganini eslatdi (maqsad universiteti / SATga tayyorgarlik)',
      'Asosiy savolni berdi: "o\'sha reja hali kuchdami yoki bir yoqli qildingizmi?"',
      'Pauza qilib, javobga qarab yo\'naldi (dolzarb / boshqa joyga yozilgan / qiziqmayman)',
    ],
  },
  {
    key: 'holat_filtr',
    title: '3. Holatni aniqlash va filtr',
    points: 8,
    checks: [
      'Hozirgi maqsadini so\'radi (jiddiy tayyorlanmoqchimi yoki hozircha ko\'rib turibdimi)',
      'O\'quvchi hozir nechanchi sinfda / talabami — so\'radi (6-7 oyda o\'zgargan bo\'lishi mumkin)',
      'Qaysi universitet/davlatni mo\'ljallayotganini so\'radi',
      'Mos kelmasa — ehtirom bilan yakunladi, vaqt sarflamadi',
    ],
  },
  {
    key: 'programmalashtirish',
    title: '4. Programmalashtirish (suhbatni boshqarish)',
    points: 6,
    checks: [
      'Suhbat tartibini aytdi (avval holat va maqsad, keyin kurs, oxirida birga qaror)',
      'Ruxsat oldi: "Bo\'ladimi?" kabi kichik "ha" so\'radi',
    ],
  },
  {
    key: 'ehtiyoj',
    title: '5. Ehtiyojni qayta aniqlash',
    points: 12,
    checks: [
      'MUHIM: "o\'sha paytdan beri biror qadam tashladingizmi — kurs, repetitor, mustaqil?" deb so\'radi',
      'Hozirgi ingliz tili / SAT darajasini so\'radi',
      'Mo\'ljaldagi ball va universitetni so\'radi',
      'Muddatni so\'radi (qachongacha topshirishi kerak)',
      'KO\'PROQ TINGLADI — mijozni bo\'lmadi',
    ],
  },
  {
    key: 'yoqotilgan_vaqt',
    title: '6. A/B nuqta va YO\'QOTILGAN VAQT',
    points: 12,
    checks: [
      'Universitetga kirish nega muhimligini so\'radi',
      'Kirsa hayotida nima o\'zgarishini so\'radi',
      'YO\'QOTILGAN VAQTNI ko\'rsatdi: "o\'shandan beri 6-7 oy o\'tdi, o\'shanda boshlaganingizda hozir ancha oldinda bo\'lardingiz"',
      'Mijozni AYBLAMADI — yumshoq va hurmat bilan aytdi',
      'Hozir aniq qadam qo\'yishga chorladi ("yana necha oy yo\'qotmaslik uchun")',
    ],
  },
  {
    key: 'taqdimot',
    title: '7. Taqdimot (nima yangilandi + yechim)',
    points: 10,
    checks: [
      'Ruxsat oldi ("tayyor tizim va yo\'l xaritasi bo\'lsa, foydalanardingizmi?")',
      'ESKI BAZAGA XOS: "siz qiziqqan paytdan beri bizda nima yaxshilandi" — yangi metodika/natija/format aytdi',
      'Modullarni foyda tilida aytdi (diagnostika, R&W, Math, ball strategiyasi, admission, aktivlar, qo\'llab-quvvatlash)',
      'Tariflarni tushuntirdi (Standart / Premium / VIP) — avval qiymat, keyin narx',
    ],
  },
  {
    key: 'probniy',
    title: '8. Probniyga chaqirish (ASOSIY yopish)',
    points: 20,
    checks: [
      'Bepul probniy darsga aniq taklif qildi ("avval darajangizni jonli ko\'rib olaylik")',
      'ESKI ARIZACHILAR uchun maxsus/bepul ekanini aytdi',
      'Aniq vaqt va TANLOV berdi (shanba soat 10:00 mi yoki 14:00 mi)',
      'Joy cheklanganini aytdi (24 kishi) va joyni band qilishni taklif qildi',
      'Yopiq kanalga qo\'shish / lokatsiya yuborishni aytdi',
    ],
  },
  {
    key: 'etiroz',
    title: '9. E\'tirozlar bilan ishlash',
    points: 6,
    checks: [
      'FORMULA: qo\'shilish → argument → kichik qadam (probniy)',
      '"Sizni eslolmayapman / kim edingiz" — tabiiy deb qabul qildi, arizani eslatdi, ruxsat so\'rab davom etdi',
      '"Endi qiziqmayman" — qiziqish o\'tdimi yoki maqsad hal bo\'ldimi deb yumshoq aniqlashtirdi',
      '"Boshqa kursga yozilganman" — natijadan qoniqyaptimi deb so\'radi, solishtirish uchun probniyga chaqirdi',
      '"Raqamimni qayerdan oldingiz" — sayt/reklama orqali o\'zi ariza qoldirganini xotirjam tushuntirdi',
      '"Pul yo\'q / qimmat / o\'ylab ko\'raman / natija bo\'lmasachi" — argument berib, probniyga chaqirdi',
    ],
  },
  {
    key: 'yopish',
    title: '10. Yopish va yakunlash',
    points: 4,
    checks: [
      'TANLOV berdi (Standart yoki Premium / soat 10 mi 14 mi)',
      'Joyni band qilish yoki oldindan to\'lov haqida aniq gapirdi',
      'Telegramda link/lokatsiya yuborishni aytdi',
      'Ertangi eslatma qo\'ng\'irog\'ini belgiladi',
    ],
  },
];

// Bandlar nomini solishtirish uchun.
function normTitle(s: string): string {
  return s.toLowerCase().replace(/^\s*\d+[b.)]*\s*/i, '').replace(/[^a-zа-яo'`ʻʻ\s]/gi, '').trim();
}

function matchStage(title: string, stages?: ScriptStage[]): ScriptStage | undefined {
  const b = normTitle(title);
  return (stages && stages.length ? stages : [...FRESH_LEAD_SCRIPT, ...REACTIVATION_SCRIPT]).find((st) => {
    const a = normTitle(st.title);
    return a === b || a.startsWith(b.slice(0, 12)) || b.startsWith(a.slice(0, 12));
  });
}

// UMUMIY BALLNI BANDLARDAN HISOBLAYDI (0-100), skript bandlari topilsa.
//
// NEGA: model kpi_score'ni bandlardan mustaqil qo'yardi va raqamlar
// to'g'ri kelmasdi — masalan ball 7.5 bo'lsa-yu, bandlardan yo'qotilgan
// ball yig'indisi 3.7 chiqardi ("nega 7.5?" degan savol javobsiz qolardi).
// Endi ball = Σ(band og'irligi × band foizi). Model faqat bandlarni
// baholaydi, arifmetikani biz qilamiz.
export function scoreFromCriteria(
  criteriaScores: Array<{ title: string; score: number }>,
  stages?: ScriptStage[],
): number | null {
  if (!criteriaScores.length) return null;
  let total = 0;
  let covered = 0;
  for (const cs of criteriaScores) {
    const stage = matchStage(cs.title, stages);
    if (!stage) continue;
    const pct = Math.max(0, Math.min(100, Number(cs.score) || 0));
    total += (stage.points * pct) / 100;
    covered += stage.points;
  }
  // Bandlarning kamida 60% og'irligi topilmasa — modelning ballini qoldiramiz.
  if (covered < 60) return null;
  // Ba'zi bandlar tushib qolsa, bor bandlar ulushiga moslab normallaymiz.
  const normalized = covered >= 95 ? total : (total / covered) * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

// Izoh matnidagi "Ball X.X/10" ni haqiqiy ball bilan almashtiradi.
export function rewriteBallText(evaluation: string, kpi0to100: number): string {
  const ten = (kpi0to100 / 10).toFixed(1);
  if (/Ball\s*[\d.,]+\s*\/\s*10/i.test(evaluation)) {
    return evaluation.replace(/Ball\s*[\d.,]+\s*\/\s*10/i, `Ball ${ten}/10`);
  }
  return evaluation;
}

// "XATOLAR:" bo'limidagi har bir qatorga necha ball yo'qotilganini qo'shadi.
//
// Modelga arifmetikani ishonib bo'lmaydi, shu sabab MINUS backendda
// hisoblanadi: band og'irligi × (100 − olingan foiz) / 100. Model faqat
// "qaysi bandda nimani qilmagani" matnini beradi.
// Natija: "− 2.0 · Probniyga chaqirish: bepul darsga taklif qilmadi".
// Frontend shu "−" bilan boshlanadigan qatorlarni QIZIL qilib ko'rsatadi.
export function annotateMistakeLines(
  evaluation: string,
  criteriaScores: Array<{ title: string; score: number }>,
  stages?: ScriptStage[],
): string {
  if (!evaluation || !evaluation.includes('XATOLAR')) return evaluation;

  const norm = (s: string) => s.toLowerCase().replace(/^\s*\d+[b.)]*\s*/i, '').replace(/[^a-zа-яo'`ʻʻ\s]/gi, '').trim();
  const allStages = [...FRESH_LEAD_SCRIPT, ...REACTIVATION_SCRIPT];

  // Band nomi -> yo'qotilgan ball (o'sha qo'ng'iroqdagi haqiqiy ballardan).
  const lost = new Map<string, number>();
  for (const cs of criteriaScores) {
    const stage = allStages.find((st) => {
      const a = norm(st.title);
      const b = norm(cs.title);
      return a === b || a.startsWith(b.slice(0, 12)) || b.startsWith(a.slice(0, 12));
    });
    if (!stage) continue;
    const pct = Math.max(0, Math.min(100, Number(cs.score) || 0));
    const minus = (stage.points * (100 - pct)) / 1000; // 10 ballik tizimda
    if (minus >= 0.05) lost.set(norm(cs.title), minus);
  }

  const mentioned = new Set<string>();
  const out = evaluation
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*[-–—•]\s*([^:]+):\s*(.+)$/);
      if (!m) return line;
      const label = m[1].trim();
      const key = norm(label);
      let minus: number | undefined = lost.get(key);
      let hitKey = key;
      if (minus === undefined) {
        for (const [k, v] of lost) {
          if (k.startsWith(key.slice(0, 12)) || key.startsWith(k.slice(0, 12))) { minus = v; hitKey = k; break; }
        }
      }
      if (minus !== undefined) mentioned.add(hitKey);
      return minus === undefined
        ? `− ${label}: ${m[2].trim()}`
        : `− ${minus.toFixed(1)} · ${label}: ${m[2].trim()}`;
    });

  // Model ba'zi bandlarni tilga olmay ketadi. Ball yo'qotilgan HAR BIR band
  // ro'yxatda bo'lishi shart — aks holda "ball nega tushdi?" degan savol
  // javobsiz qoladi. Qolganlarini shu yerda qo'shamiz.
  const missing = [...lost.entries()]
    .filter(([k]) => !mentioned.has(k))
    .sort((a, b) => b[1] - a[1]);
  if (missing.length) {
    const titleOf = (key: string) =>
      criteriaScores.find((c) => norm(c.title) === key)?.title.replace(/^\s*\d+[b.)]*\s*/i, '') || key;
    for (const [k, v] of missing) {
      out.push(`− ${v.toFixed(1)} · ${titleOf(k)}: to'liq bajarilmadi`);
    }
  }

  return out.join('\n');
}

// Ikkala skript ham bitta matnda beriladi; AI avval turini aniqlaydi.
//
// fresh/reactivation berilsa — O'SHALAR ishlatiladi. Bu kompaniya
// dashboarddagi "Mezonlar" bo'limida skriptni tahrirlasa, baholash ham
// o'sha tahrirlangan variant bo'yicha ketishi uchun (2026-09-24).
export function buildScriptRules(fresh?: ScriptStage[], reactivation?: ScriptStage[]): string {
  const FRESH = fresh && fresh.length ? fresh : FRESH_LEAD_SCRIPT;
  const REACT = reactivation && reactivation.length ? reactivation : REACTIVATION_SCRIPT;
  const stageBlock = (stages: ScriptStage[]): string[] => {
    const out: string[] = [];
    for (const st of stages) {
      out.push(`${st.title} — ${st.points} ball (10 ballikda ${(st.points / 10).toFixed(1)}):`);
      for (const c of st.checks) out.push(`   - ${c}`);
      out.push('');
    }
    return out;
  };

  return [
    'BAHOLASH SKRIPTLARI — bu SAT / universitetga tayyorlov kursi call-center skriptlari.',
    '',
    'QADAM 1 — QO\'NG\'IROQ TURINI ANIQLANG:',
    '   (A) YANGI LID — mijoz hozir qiziqib murojaat qilgan/ariza qoldirgan, suhbat yangi tanishuvdek ketadi.',
    '   (B) ESKI BAZA — mijoz ANCHA OLDIN (masalan 6-7 oy) ariza qoldirgan va qayta jonlantirilyapti. Belgilari: operator "oldin ariza qoldirgan edingiz", "6 oy oldin", "o\'shanda ulgurmagansiz" deydi; yoki mijoz "sizni eslolmayapman", "kim edingiz", "raqamimni qayerdan oldingiz", "boshqa kursga yozilganman" deydi.',
    '   Ikkalasiga ham aniq mos kelmasa — (A) YANGI LID skriptini oling.',
    '',
    'QADAM 2 — FAQAT O\'SHA SKRIPT bo\'yicha baholang. Ikkinchi skriptning bandlarini criteria_scores\'ga QO\'SHMANG.',
    'operator_evaluation izohining boshida qaysi skript ishlatilganini yozing: "(Yangi lid)" yoki "(Eski baza)".',
    'Har band ichidagi tekshiruvlar qancha bajarilganiga qarab shu banddan ball bering (qisman bajarilsa — qisman ball).',
    '',
    'IKKALA SKRIPTNING ASOSIY QOIDASI: telefonda kurs SOTILMAYDI — maqsad mijozni BEPUL PROBNIY darsga olib kelish. Shu sabab probniyga chaqirish eng og\'ir band.',
    '',
    'ADOLAT QOIDALARI (ball nohaq tushmasin):',
    '   - BAND QO\'LLANMASA — 100 qo\'ying, 0 emas. Masalan mijoz umuman e\'tiroz bildirmagan bo\'lsa, e\'tiroz bandi 100 bo\'ladi va izohda "(e\'tiroz bo\'lmadi)" deb yozing. 0 faqat BAJARILISHI KERAK BO\'LIB, bajarilmagan bandga qo\'yiladi.',
    '   - Mijoz suhbatni o\'zi darhol tugatgan yoki javob bermagan bo\'lsa — operatorni keyingi bosqichlar uchun jazolamang, faqat bajarilgan qismni baholang.',
    '   - Mijoz filtrdan o\'tmagan bo\'lsa (maqsadsiz, mos emas) va operator ehtirom bilan yakunlagan bo\'lsa — bu TO\'G\'RI ish, ball tushmasin.',
    '   - Kiruvchi (mijoz o\'zi qo\'ng\'iroq qilgan) suhbatda salomlashish/povod bandini shunga moslab baholang.',
    '   - Transkriptda ovoz ohangini to\'liq baholab bo\'lmaydi — faqat so\'z va tuzilishga qarab baho bering.',
    '',
    '════════ (A) YANGI LID SKRIPTI ════════',
    '',
    ...stageBlock(FRESH),
    '════════ (B) ESKI BAZANI QAYTA JONLANTIRISH SKRIPTI ════════',
    '',
    ...stageBlock(REACT),
    'kpi_score — TANLANGAN skript bandlari ballarining YIG\'INDISI (0-100).',
    'criteria_scores — tanlangan skriptning har bir bandi uchun bitta element: {title: band nomi, category: "Skript", score: o\'sha band necha foiz bajarilgani (0-100)}.',
    'Qo\'ng\'iroq javobsiz qolgan yoki suhbat umuman bo\'lmagan bo\'lsa — kpi_score 0 va criteria_scores bo\'sh massiv.',
  ].join('\n');
}
