/**
 * Interface strings.
 *
 * Four languages, because the people this site is for do not all read Hebrew,
 * and the moment someone needs a food parcel or a shelter is the worst possible
 * moment to be handed a language they are still learning.
 *
 * The wording is deliberately plain: short sentences, no institutional register,
 * no words like "eligibility criteria". Someone reading this may be frightened,
 * exhausted, or reading on a cracked phone screen in the street.
 */

export const LANGS = ['he', 'ar', 'ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const RTL: ReadonlySet<Lang> = new Set<Lang>(['he', 'ar']);

export const LANG_NAMES: Record<Lang, string> = {
  he: 'עברית',
  ar: 'العربية',
  ru: 'Русский',
  en: 'English',
};

interface Strings {
  siteName: string;
  tagline: string;
  askPrompt: string;
  searchPlaceholder: string;
  searchAction: string;
  smartAction: string;
  smartHint: string;
  smartThinking: string;
  smartUnderstood: string;
  smartNoKey: string;
  smartError: string;
  smartBackToPlain: string;
  deepAction: string;
  deepHint: string;
  deepSources: string;
  deepUnavailable: (names: string) => string;
  a11yTitle: string;
  a11yLink: string;
  nearMe: string;
  nearMeWorking: string;
  locationDenied: string;
  chooseCity: string;
  commonNeeds: string;
  needFood: string;
  needMoney: string;
  needHousing: string;
  needHealth: string;
  needMental: string;
  needViolence: string;
  urgentHelp: string;
  urgentHelpBody: string;
  callNow: string;
  results: string;
  resultsCount: (n: number) => string;
  noResults: string;
  noResultsBody: string;
  loading: string;
  loadMore: string;
  filters: string;
  clearFilters: string;
  whatKind: string;
  whoFor: string;
  where: string;
  anywhere: string;
  nationwide: string;
  nationwideNote: string;
  approximateLocation: string;
  distanceAway: (km: string) => string;
  alsoOfferedBy: (n: number) => string;
  alsoAvailableAt: (n: number) => string;
  branches: (n: number) => string;
  call: string;
  whatsapp: string;
  directions: string;
  website: string;
  email: string;
  save: string;
  saved: string;
  share: string;
  shareCopied: string;
  suitableFor: string;
  whatYouGet: string;
  conditions: string;
  practicalInfo: string;
  resultsHeading: string;
  free: string;
  paymentRequired: string;
  howToApply: string;
  whereAndWhen: string;
  providedBy: string;
  moreAtThisPlace: string;
  sourceAndDate: (date: string) => string;
  reportError: string;
  reportErrorTitle: string;
  reportErrorBody: string;
  reportErrorSend: string;
  reportErrorThanks: string;
  myFolder: string;
  myFolderEmpty: string;
  myFolderBody: string;
  remove: string;
  back: string;
  language: string;
  skipToContent: string;
  disclaimer: string;
  aboutLink: string;
  apiLink: string;
}

const he: Strings = {
  siteName: 'כל השירותים החברתיים',
  tagline: 'לחפש עזרה, ולמצוא אותה',
  askPrompt: 'במה אפשר לעזור?',
  searchPlaceholder: 'לדוגמה: אין לי כסף לאוכל',
  searchAction: 'חיפוש',
  smartAction: 'חיפוש חכם',
  smartHint: 'אפשר לכתוב במילים שלכם — למשל "אין לי כסף לאוכל ואני בתל אביב" — והחיפוש החכם יבין למה הכוונה.',
  smartThinking: 'מחפש עבורכם…',
  smartUnderstood: 'מה הבנו מהבקשה',
  smartNoKey: 'החיפוש החכם אינו זמין כרגע. החיפוש הרגיל עובד כרגיל.',
  smartError: 'משהו השתבש בחיפוש החכם. אפשר לנסות את החיפוש הרגיל.',
  smartBackToPlain: 'לחיפוש הרגיל',
  deepAction: 'חיפוש בכל המקורות',
  deepHint: 'מצרף גם מקורות חיצוניים — למשל כדי לבדוק אם עמותה עדיין רשומה. איטי יותר.',
  deepSources: 'מקורות שנבדקו',
  deepUnavailable: (names) => `מקורות שלא הגיבו: ${names}`,
  a11yTitle: 'הצהרת נגישות',
  a11yLink: 'נגישות',
  nearMe: 'לפי המיקום שלי',
  nearMeWorking: 'מאתר את המיקום…',
  locationDenied: 'לא הצלחנו לאתר את המיקום. אפשר לבחור עיר במקום.',
  chooseCity: 'בחירת עיר',
  commonNeeds: 'נושאים נפוצים',
  needFood: 'אוכל',
  needMoney: 'כסף',
  needHousing: 'דיור',
  needHealth: 'בריאות',
  needMental: 'מצוקה נפשית',
  needViolence: 'אלימות',
  urgentHelp: 'צריך עזרה עכשיו',
  urgentHelpBody: 'קווי סיוע שעונים מיד, בכל שעה.',
  callNow: 'להתקשר עכשיו',
  results: 'תוצאות',
  resultsCount: (n) => (n === 1 ? 'שירות אחד' : `${n} שירותים`),
  noResults: 'לא מצאנו שירות מתאים',
  noResultsBody: 'אפשר לנסות מילה אחרת, להסיר סינון, או להרחיב את אזור החיפוש.',
  loading: 'טוען…',
  loadMore: 'עוד תוצאות',
  filters: 'סינון',
  clearFilters: 'ניקוי הסינון',
  whatKind: 'מה צריך',
  whoFor: 'למי',
  where: 'איפה',
  anywhere: 'בכל הארץ',
  nationwide: 'שירות ארצי',
  nationwideNote: 'ניתן בכל הארץ, בלי צורך להגיע למקום מסוים.',
  approximateLocation: 'המיקום המוצג משוער — כדאי לוודא בטלפון',
  distanceAway: (km) => `${km} ק״מ ממך`,
  alsoOfferedBy: (n) => (n === 1 ? 'ארגון נוסף מפעיל שירות דומה' : `עוד ${n} ארגונים מפעילים שירות דומה`),
  alsoAvailableAt: (n) => (n === 1 ? 'זמין גם במקום אחד נוסף' : `זמין גם ב־${n} מקומות נוספים`),
  branches: (n) => (n === 1 ? 'סניף אחד' : `${n} סניפים`),
  call: 'חיוג',
  whatsapp: 'וואטסאפ',
  directions: 'ניווט',
  website: 'לאתר',
  email: 'מייל',
  save: 'שמירה',
  saved: 'נשמר',
  share: 'שיתוף',
  shareCopied: 'הקישור הועתק',
  suitableFor: 'מתאים עבור',
  whatYouGet: 'מה מקבלים',
  conditions: 'תנאים',
  practicalInfo: 'איך מקבלים',
  resultsHeading: 'תוצאות החיפוש',
  free: 'ללא תשלום',
  paymentRequired: 'כרוך בתשלום',
  howToApply: 'איך פונים',
  whereAndWhen: 'איפה',
  providedBy: 'מי מפעיל',
  moreAtThisPlace: 'עוד שירותים באותו מקום',
  sourceAndDate: (date) => `המידע עודכן ב־${date}`,
  reportError: 'משהו כאן לא נכון?',
  reportErrorTitle: 'דיווח על טעות',
  reportErrorBody: 'מה לא נכון? למשל: הטלפון לא עונה, הכתובת השתנתה, השירות נסגר.',
  reportErrorSend: 'שליחה',
  reportErrorThanks: 'תודה, הדיווח התקבל ויטופל.',
  myFolder: 'שמורים',
  myFolderEmpty: 'עוד לא שמרת שירותים',
  myFolderBody: 'אפשר לשמור שירותים כדי לחזור אליהם, או לשלוח את הרשימה למישהו.',
  remove: 'הסרה',
  back: 'חזרה',
  language: 'שפה',
  skipToContent: 'דילוג לתוכן',
  disclaimer:
    'המידע נאסף ממקורות שונים ועשוי להיות חלקי או לא מעודכן. מומלץ לוודא טלפונית לפני הגעה.',
  aboutLink: 'אודות',
  apiLink: 'למפתחים',
};

const ar: Strings = {
  siteName: 'كل الخدمات الاجتماعية',
  tagline: 'ابحث عن المساعدة، وجدها',
  askPrompt: 'كيف يمكننا المساعدة؟',
  searchPlaceholder: 'مثال: ليس لدي مال للطعام',
  searchAction: 'بحث',
  smartAction: 'بحث ذكي',
  smartHint: 'اكتبوا بكلماتكم — مثلاً "ليس لدي مال للطعام وأنا في تل أبيب" — والبحث الذكي سيفهم المقصود.',
  smartThinking: 'نبحث لكم…',
  smartUnderstood: 'ما فهمناه من طلبكم',
  smartNoKey: 'البحث الذكي غير متاح حالياً. البحث العادي يعمل كالمعتاد.',
  smartError: 'حدث خطأ في البحث الذكي. يمكنكم تجربة البحث العادي.',
  smartBackToPlain: 'إلى البحث العادي',
  deepAction: 'بحث في كل المصادر',
  deepHint: 'يضم مصادر خارجية أيضاً — مثلاً للتحقق ممّا إذا كانت الجمعية ما زالت مسجّلة. أبطأ.',
  deepSources: 'المصادر التي فُحصت',
  deepUnavailable: (names) => `مصادر لم تستجب: ${names}`,
  a11yTitle: 'بيان إمكانية الوصول',
  a11yLink: 'إمكانية الوصول',
  nearMe: 'حسب موقعي',
  nearMeWorking: 'جارٍ تحديد الموقع…',
  locationDenied: 'تعذّر تحديد الموقع. يمكنك اختيار مدينة بدلاً من ذلك.',
  chooseCity: 'اختيار مدينة',
  commonNeeds: 'مواضيع شائعة',
  needFood: 'طعام',
  needMoney: 'مال',
  needHousing: 'سكن',
  needHealth: 'صحة',
  needMental: 'ضائقة نفسية',
  needViolence: 'عنف',
  urgentHelp: 'أحتاج مساعدة الآن',
  urgentHelpBody: 'خطوط مساعدة تجيب فوراً، في أي ساعة.',
  callNow: 'اتصل الآن',
  results: 'النتائج',
  resultsCount: (n) => (n === 1 ? 'خدمة واحدة' : `${n} خدمات`),
  noResults: 'لم نجد خدمة مناسبة',
  noResultsBody: 'جرّب كلمة أخرى، أو أزل الفلاتر، أو وسّع منطقة البحث.',
  loading: 'جارٍ التحميل…',
  loadMore: 'المزيد',
  filters: 'تصفية',
  clearFilters: 'مسح التصفية',
  whatKind: 'ما الذي تحتاجه',
  whoFor: 'لمن',
  where: 'أين',
  anywhere: 'في كل البلاد',
  nationwide: 'خدمة على مستوى البلاد',
  nationwideNote: 'متاحة في كل البلاد، دون الحاجة للوصول إلى مكان معيّن.',
  approximateLocation: 'الموقع المعروض تقريبي — يُفضّل التأكد هاتفياً',
  distanceAway: (km) => `${km} كم عنك`,
  alsoOfferedBy: (n) => (n === 1 ? 'جمعية أخرى تقدّم خدمة مشابهة' : `${n} جمعيات أخرى تقدّم خدمة مشابهة`),
  alsoAvailableAt: (n) => (n === 1 ? 'متاح أيضاً في مكان آخر' : `متاح أيضاً في ${n} أماكن أخرى`),
  branches: (n) => (n === 1 ? 'فرع واحد' : `${n} فروع`),
  call: 'اتصال',
  whatsapp: 'واتساب',
  directions: 'الطريق',
  website: 'الموقع',
  email: 'بريد',
  save: 'حفظ',
  saved: 'محفوظ',
  share: 'مشاركة',
  shareCopied: 'تم نسخ الرابط',
  suitableFor: 'مناسبة لـ',
  whatYouGet: 'ما الذي تحصل عليه',
  conditions: 'الشروط',
  practicalInfo: 'كيف تحصل عليها',
  resultsHeading: 'نتائج البحث',
  free: 'بدون مقابل',
  paymentRequired: 'مقابل رسوم',
  howToApply: 'كيفية التقديم',
  whereAndWhen: 'أين',
  providedBy: 'الجهة المشغّلة',
  moreAtThisPlace: 'خدمات أخرى في نفس المكان',
  sourceAndDate: (date) => `حُدّثت المعلومات في ${date}`,
  reportError: 'هناك خطأ؟',
  reportErrorTitle: 'الإبلاغ عن خطأ',
  reportErrorBody: 'ما هو الخطأ؟ مثلاً: الهاتف لا يجيب، العنوان تغيّر، الخدمة أُغلقت.',
  reportErrorSend: 'إرسال',
  reportErrorThanks: 'شكراً، تم استلام البلاغ.',
  myFolder: 'المحفوظة',
  myFolderEmpty: 'لم تحفظ خدمات بعد',
  myFolderBody: 'يمكنك حفظ خدمات للعودة إليها، أو إرسال القائمة لشخص آخر.',
  remove: 'إزالة',
  back: 'رجوع',
  language: 'اللغة',
  skipToContent: 'تخطّي إلى المحتوى',
  disclaimer:
    'المعلومات مجمّعة من مصادر مختلفة وقد تكون ناقصة أو غير محدّثة. يُنصح بالتأكد هاتفياً قبل الحضور.',
  aboutLink: 'حول',
  apiLink: 'للمطوّرين',
};

const ru: Strings = {
  siteName: 'Все социальные службы',
  tagline: 'Искать помощь — и находить её',
  askPrompt: 'Чем помочь?',
  searchPlaceholder: 'Например: нет денег на еду',
  searchAction: 'Найти',
  smartAction: 'Умный поиск',
  smartHint: 'Можно написать своими словами — например «нет денег на еду, я в Тель-Авиве» — и умный поиск поймёт.',
  smartThinking: 'Ищем для вас…',
  smartUnderstood: 'Как мы поняли запрос',
  smartNoKey: 'Умный поиск сейчас недоступен. Обычный поиск работает.',
  smartError: 'Умный поиск не сработал. Попробуйте обычный поиск.',
  smartBackToPlain: 'К обычному поиску',
  deepAction: 'Поиск по всем источникам',
  deepHint: 'Обращается и к внешним источникам — например, чтобы проверить регистрацию организации. Медленнее.',
  deepSources: 'Проверенные источники',
  deepUnavailable: (names) => `Источники без ответа: ${names}`,
  a11yTitle: 'Заявление о доступности',
  a11yLink: 'Доступность',
  nearMe: 'Рядом со мной',
  nearMeWorking: 'Определяем местоположение…',
  locationDenied: 'Не удалось определить местоположение. Можно выбрать город.',
  chooseCity: 'Выбрать город',
  commonNeeds: 'Частые темы',
  needFood: 'Еда',
  needMoney: 'Деньги',
  needHousing: 'Жильё',
  needHealth: 'Здоровье',
  needMental: 'Душевное состояние',
  needViolence: 'Насилие',
  urgentHelp: 'Нужна помощь сейчас',
  urgentHelpBody: 'Горячие линии отвечают сразу, в любое время.',
  callNow: 'Позвонить',
  results: 'Результаты',
  resultsCount: (n) => `${n} служб`,
  noResults: 'Подходящих служб не найдено',
  noResultsBody: 'Попробуйте другое слово, снимите фильтры или расширьте район поиска.',
  loading: 'Загрузка…',
  loadMore: 'Ещё',
  filters: 'Фильтры',
  clearFilters: 'Сбросить',
  whatKind: 'Что нужно',
  whoFor: 'Для кого',
  where: 'Где',
  anywhere: 'По всей стране',
  nationwide: 'По всей стране',
  nationwideNote: 'Доступно по всей стране, приходить никуда не нужно.',
  approximateLocation: 'Точка показана приблизительно — лучше уточнить по телефону',
  distanceAway: (km) => `${km} км от вас`,
  alsoOfferedBy: (n) => `Ещё ${n} организаций предлагают похожее`,
  alsoAvailableAt: (n) => `Ещё в ${n} местах`,
  branches: (n) => `${n} отделений`,
  call: 'Позвонить',
  whatsapp: 'WhatsApp',
  directions: 'Маршрут',
  website: 'Сайт',
  email: 'Почта',
  save: 'Сохранить',
  saved: 'Сохранено',
  share: 'Поделиться',
  shareCopied: 'Ссылка скопирована',
  suitableFor: 'Подходит для',
  whatYouGet: 'Что вы получите',
  conditions: 'Условия',
  practicalInfo: 'Как получить',
  resultsHeading: 'Результаты поиска',
  free: 'Бесплатно',
  paymentRequired: 'Платно',
  howToApply: 'Как обратиться',
  whereAndWhen: 'Где',
  providedBy: 'Кто предоставляет',
  moreAtThisPlace: 'Другие службы в том же месте',
  sourceAndDate: (date) => `Данные обновлены ${date}`,
  reportError: 'Что-то неверно?',
  reportErrorTitle: 'Сообщить об ошибке',
  reportErrorBody: 'Что не так? Например: телефон не отвечает, адрес изменился, служба закрылась.',
  reportErrorSend: 'Отправить',
  reportErrorThanks: 'Спасибо, сообщение получено.',
  myFolder: 'Сохранённое',
  myFolderEmpty: 'Вы ещё ничего не сохранили',
  myFolderBody: 'Сохраняйте службы, чтобы вернуться к ним или отправить список другому человеку.',
  remove: 'Убрать',
  back: 'Назад',
  language: 'Язык',
  skipToContent: 'Перейти к содержанию',
  disclaimer:
    'Информация собрана из разных источников и может быть неполной или устаревшей. Перед визитом лучше позвонить.',
  aboutLink: 'О проекте',
  apiLink: 'Разработчикам',
};

const en: Strings = {
  siteName: 'Social services directory',
  tagline: 'Look for help, and find it',
  askPrompt: 'What do you need?',
  searchPlaceholder: 'For example: I have no money for food',
  searchAction: 'Search',
  smartAction: 'Smart search',
  smartHint: 'You can write in your own words — "I have no money for food and I am in Tel Aviv" — and smart search will work out what you mean.',
  smartThinking: 'Searching for you…',
  smartUnderstood: 'What we understood',
  smartNoKey: 'Smart search is not available right now. Ordinary search works as usual.',
  smartError: 'Smart search did not work. Please try the ordinary search.',
  smartBackToPlain: 'Back to ordinary search',
  deepAction: 'Search all sources',
  deepHint: 'Also reaches external sources — for example to check whether a charity is still registered. Slower.',
  deepSources: 'Sources checked',
  deepUnavailable: (names) => `Sources that did not respond: ${names}`,
  a11yTitle: 'Accessibility statement',
  a11yLink: 'Accessibility',
  nearMe: 'Near me',
  nearMeWorking: 'Finding your location…',
  locationDenied: 'We could not find your location. You can pick a city instead.',
  chooseCity: 'Choose a city',
  commonNeeds: 'Common needs',
  needFood: 'Food',
  needMoney: 'Money',
  needHousing: 'Housing',
  needHealth: 'Health',
  needMental: 'Mental health',
  needViolence: 'Violence',
  urgentHelp: 'I need help now',
  urgentHelpBody: 'Helplines that answer immediately, at any hour.',
  callNow: 'Call now',
  results: 'Results',
  resultsCount: (n) => (n === 1 ? '1 service' : `${n} services`),
  noResults: 'No matching service found',
  noResultsBody: 'Try another word, remove a filter, or widen the search area.',
  loading: 'Loading…',
  loadMore: 'More results',
  filters: 'Filters',
  clearFilters: 'Clear filters',
  whatKind: 'What you need',
  whoFor: 'Who it is for',
  where: 'Where',
  anywhere: 'Anywhere in the country',
  nationwide: 'Nationwide',
  nationwideNote: 'Available anywhere in the country — you do not have to travel.',
  approximateLocation: 'This location is approximate — please confirm by phone',
  distanceAway: (km) => `${km} km away`,
  alsoOfferedBy: (n) => (n === 1 ? '1 more organisation offers something similar' : `${n} more organisations offer something similar`),
  alsoAvailableAt: (n) => (n === 1 ? 'Also available at 1 other place' : `Also available at ${n} other places`),
  branches: (n) => (n === 1 ? '1 branch' : `${n} branches`),
  call: 'Call',
  whatsapp: 'WhatsApp',
  directions: 'Directions',
  website: 'Website',
  email: 'Email',
  save: 'Save',
  saved: 'Saved',
  share: 'Share',
  shareCopied: 'Link copied',
  suitableFor: 'Suitable for',
  whatYouGet: 'What you get',
  conditions: 'Conditions',
  practicalInfo: 'How to get it',
  resultsHeading: 'Search results',
  free: 'Free',
  paymentRequired: 'There is a charge',
  howToApply: 'How to apply',
  whereAndWhen: 'Where',
  providedBy: 'Provided by',
  moreAtThisPlace: 'More services at the same place',
  sourceAndDate: (date) => `Information updated ${date}`,
  reportError: 'Something wrong here?',
  reportErrorTitle: 'Report a problem',
  reportErrorBody: 'What is wrong? For example: the phone does not answer, the address changed, the service closed.',
  reportErrorSend: 'Send',
  reportErrorThanks: 'Thank you, we have your report.',
  myFolder: 'Saved',
  myFolderEmpty: 'You have not saved anything yet',
  myFolderBody: 'Save services to come back to them, or send the list to someone else.',
  remove: 'Remove',
  back: 'Back',
  language: 'Language',
  skipToContent: 'Skip to content',
  disclaimer:
    'This information is collected from several sources and may be incomplete or out of date. Please confirm by phone before travelling.',
  aboutLink: 'About',
  apiLink: 'Developers',
};

const TABLE: Record<Lang, Strings> = { he, ar, ru, en };

export function stringsFor(lang: Lang): Strings {
  return TABLE[lang];
}

/**
 * The language to start in: an explicit choice in the URL, then a remembered
 * one, then whatever the browser asks for, then Hebrew.
 */
export function detectLang(search: string): Lang {
  const fromUrl = new URLSearchParams(search).get('lang');
  if (isLang(fromUrl)) return fromUrl;

  try {
    const stored = localStorage.getItem('lang');
    if (isLang(stored)) return stored;
  } catch {
    // Private browsing, or storage disabled. Fall through.
  }

  for (const candidate of navigator.languages ?? []) {
    const base = candidate.split('-')[0];
    if (isLang(base)) return base;
  }
  return 'he';
}

function isLang(value: string | null | undefined): value is Lang {
  return !!value && (LANGS as readonly string[]).includes(value);
}
