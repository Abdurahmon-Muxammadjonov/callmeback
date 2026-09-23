// SOTUV SKRIPTI — SAT / Universitetga tayyorlov kursi.
// Manba: kompaniyaning o'z qo'llanmasi (call center / administrator uchun),
// foydalanuvchi bergan 2026-09-23.
//
// ASOSIY QOIDA: telefonda sotilmaydi — mijoz PROBNIY (bepul sinov) darsga
// olib kelinadi, sotuv o'sha yerda bo'ladi. Shu sabab "Probniyga chaqirish"
// bandi eng katta ulushga ega. Har bosqichda kichik "ha" so'raladi.
//
// AI har bir qo'ng'iroqni SHU bosqichlar bo'yicha tekshiradi va ball
// qo'yadi. Ball ekranda 10 ballik ko'rinishda chiqadi (ichkarida 0-100
// bo'lib saqlanadi: 7.5/10 = 75).

export interface ScriptStage {
  key: string;
  title: string;
  points: number;      // 100 ballik ichidagi ulush (10 ballikda: points/10)
  checks: string[];    // AI nimaga qarab ball qo'yadi
}

export const CALL_SCRIPT: ScriptStage[] = [
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
      'Modullarni aytdi: diagnostika, Reading & Writing, Math, ball ko\'tarish strategiyasi, admission/hujjatlar, qo\'llab-quvvatlash',
      'Modullarni XUSUSIYAT emas, FOYDA tilida aytdi ("bu sizga ... beradi")',
      'Tariflarni tushuntirdi (Standart / Premium / VIP) va narxni aniq aytdi',
      'Mijoz faqat narx so\'rasa — avval kamida 3 ta ehtiyoj savolini berdi, darrov narx aytmadi',
    ],
  },
  {
    key: 'probniy',
    title: '6b. Probniyga chaqirish (ASOSIY yopish)',
    points: 20,
    checks: [
      'Darajani aniqlash uchun test/diagnostika taklif qildi',
      'BEPUL probniy darsga aniq taklif qildi (asosiy maqsad shu)',
      'Aniq vaqt taklif qildi va TANLOV berdi (masalan: shanba soat 10 mi, 14 mi)',
      'Joy cheklanganini aytdi va joyni band qilishni taklif qildi ("kelishdikmi?")',
      'Yopiq kanalga qo\'shishni / lokatsiya yuborishni aytdi',
    ],
  },
  {
    key: 'etiroz',
    title: '7. E\'tirozlar bilan ishlash',
    points: 8,
    checks: [
      'FORMULA: avval qo\'shildi/tan oldi ("tushunaman, bu jiddiy mablag\'"), keyin argument, keyin taklif',
      'E\'tirozni rad etmadi, bahslashmadi',
      '"Pul yo\'q" — investitsiya/grant tejash, bo\'lib to\'lash taklif qilindi',
      '"O\'ylab ko\'raman" — nima o\'ylantirayotgani aniqlashtirildi (narxmi, vaqtmi, ishonchmi) va probniyga chaqirildi',
      '"Qimmat" — kunlik narxga bo\'lib ko\'rsatildi; "natija bo\'lmasachi" — real natijalar va kafolat aytildi',
      'DIQQAT: mijoz umuman e\'tiroz bildirmagan bo\'lsa — bu bandga 100 qo\'ying (bajarish uchun sabab bo\'lmagan), 0 EMAS.',
    ],
  },
  {
    key: 'yopish',
    title: '8. Yopish va keyingi qadam',
    points: 7,
    checks: [
      'TANLOV berdi ("Standart yoki Premium?") — "ha/yo\'q" savoli emas',
      'Joyni band qilish / oldindan to\'lov haqida aniq taklif qildi',
      'Telegram link yoki lokatsiya yuborishni aytdi',
      'Keyingi aloqa vaqtini aniq belgiladi ("ertaga soat ... da xabarlashaman")',
      'Chegirmani birinchi qurol sifatida ishlatmadi (avval qiymat orqali yopdi)',
    ],
  },
];

// Promptga qo'shiladigan matn.
export function buildScriptRules(): string {
  const lines: string[] = [
    'BAHOLASH SKRIPTI — bu SAT / universitetga tayyorlov kursi sotuv skripti. Qo\'ng\'iroqni AYNAN shu bosqichlar bo\'yicha tekshiring va ball qo\'ying.',
    'ASOSIY QOIDA: telefonda kurs sotilmaydi — maqsad mijozni BEPUL PROBNIY (sinov) darsga olib kelish. Shu sabab probniyga chaqirish eng muhim band.',
    'Har band ichidagi tekshiruvlar qancha bajarilganiga qarab shu banddan ball bering (qisman bajarilsa — qisman ball).',
    '',
    'ADOLAT QOIDALARI (ball nohaq tushmasin):',
    '   - Mijoz suhbatni o\'zi darhol tugatgan yoki javob bermagan bo\'lsa — operatorni keyingi bosqichlar uchun jazolamang, faqat bajarilgan qismni baholang.',
    '   - Mijoz filtrdan o\'tmagan bo\'lsa (maqsadsiz, mos emas) va operator ehtirom bilan yakunlagan bo\'lsa — bu TO\'G\'RI ish, ball tushmasin.',
    '   - Kiruvchi (mijoz o\'zi qo\'ng\'iroq qilgan) suhbatda salomlashish bandini shunga moslab baholang.',
    '   - Transkriptda ovoz ohangini to\'liq baholab bo\'lmaydi — faqat so\'z va tuzilishga qarab baho bering.',
    '   - BAND QO\'LLANMASA — 100 qo\'ying, 0 emas. Masalan mijoz e\'tiroz bildirmagan bo\'lsa, "E\'tirozlar bilan ishlash" bandi 100 bo\'ladi va izohda "(e\'tiroz bo\'lmadi)" deb yozing. 0 faqat BAJARILISHI KERAK BO\'LIB, bajarilmagan bandga qo\'yiladi.',
        '',
  ];
  for (const st of CALL_SCRIPT) {
    lines.push(`${st.title} — ${st.points} ball (10 ballikda ${(st.points / 10).toFixed(1)}):`);
    for (const c of st.checks) lines.push(`   - ${c}`);
    lines.push('');
  }
  lines.push(
    'kpi_score — shu bandlar ballarining YIG\'INDISI (0-100).',
    'criteria_scores massivini SHU bandlar bilan to\'ldiring: har band uchun {title: band nomi, category: "Skript", score: o\'sha band necha foiz bajarilgani (0-100)}.',
    'Qo\'ng\'iroq javobsiz qolgan yoki suhbat umuman bo\'lmagan bo\'lsa — kpi_score 0 va criteria_scores bo\'sh massiv.',
  );
  return lines.join('\n');
}
