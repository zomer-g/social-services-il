import { stringsFor, type Lang } from './i18n.js';

/**
 * Accessibility statement.
 *
 * Short on purpose. A statement is only worth reading if it says what was
 * actually done, what is known to be imperfect, and who to tell — so it says
 * those three things and stops.
 */
export function AccessibilityPage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const he = lang === 'he';

  return (
    <article>
      <h1>{t.a11yTitle}</h1>

      {he ? (
        <>
          <p>
            האתר הזה נועד לשמש אנשים ברגעים קשים, לעיתים קרובות מהטלפון ולעיתים בתנאים לא נוחים.
            הנגישות כאן אינה תוספת אלא חלק מהתפקוד.
          </p>

          <h2>רמת הנגישות</h2>
          <p>
            האתר נבנה לעמידה בהנחיות <strong>WCAG 2.2 ברמה AAA</strong>. בפועל זה אומר:
          </p>
          <ul>
            <li>
              יחס הניגודיות של כל טקסט הוא לפחות 7:1 מול הרקע שעליו הוא מופיע, ושל גבולות של פקדים
              לפחות 3:1. הערכים חושבו ונבדקו, לא הוערכו בעין — הבדיקה רצה כחלק מהקוד.
            </li>
            <li>כל כפתור, קישור וצ׳יפ הוא לפחות 44 על 44 פיקסלים, כדי שאפשר יהיה ללחוץ עליו גם ביד רועדת.</li>
            <li>רווח שורה של 1.6, רווח פסקה של פי 1.6 מגובה השורה, ושורת טקסט שאינה חורגת מכ־72 תווים.</li>
            <li>אין טקסט מיושר לשני הצדדים, ואפשר להגדיל את הטקסט ל־200% בלי גלילה לצדדים.</li>
            <li>כל האתר עובד במקלדת בלבד, עם סימון מיקוד ברור וקישור דילוג לתוכן.</li>
            <li>אין הבהובים, אין תנועה אוטומטית, ומי שביקש הפחתת תנועה במערכת ההפעלה מקבל אתר ללא אנימציות.</li>
            <li>אין הגבלת זמן על אף פעולה.</li>
            <li>האתר בעברית, ערבית, רוסית ואנגלית, עם כיוון כתיבה נכון בכל אחת מהן.</li>
          </ul>

          <h2>מה ידוע לנו שאינו מושלם</h2>
          <ul>
            <li>
              המידע עצמו מגיע ממקורות חיצוניים. חלק מהתיאורים כתובים בשפה מנהלית ולא בשפה פשוטה, ואין
              לנו שליטה על הניסוח שלהם.
            </li>
            <li>
              חלק מהכתובות לא אותרו במדויק על המפה. כרטיס שבו המיקום משוער אומר זאת במפורש, אבל עדיין
              כדאי לוודא בטלפון לפני הגעה.
            </li>
            <li>
              החיפוש החכם מסתמך על שירות חיצוני. הוא תוספת בלבד — החיפוש הרגיל עובד תמיד ואינו תלוי בו.
            </li>
          </ul>

          <h2>נתקלתם בבעיה?</h2>
          <p>
            אם משהו באתר אינו נגיש עבורכם, נשמח לדעת. אפשר לפתוח דיווח ב־
            <a href="https://github.com/zomer-g/social-services-il/issues">מערכת הדיווחים של הפרויקט</a>, וגם
            בכל עמוד שירות יש כפתור "משהו כאן לא נכון?" לדיווח על תוכן שגוי.
          </p>
          <p className="source">הצהרה זו עודכנה בספטמבר 2026.</p>
        </>
      ) : (
        <>
          <p>
            This site is meant to be used at difficult moments, often on a phone and often in
            awkward conditions. Accessibility here is part of the thing working, not an addition to it.
          </p>

          <h2>Conformance</h2>
          <p>
            The site is built to meet <strong>WCAG 2.2 level AAA</strong>. In practice:
          </p>
          <ul>
            <li>
              Every text colour clears 7:1 against every surface it appears on, and control borders
              clear 3:1. The values were solved for and are verified by a check that runs with the code.
            </li>
            <li>Every button, link and chip is at least 44 by 44 pixels, so it can be hit with an unsteady hand.</li>
            <li>Line height 1.6, paragraph spacing 1.6 times the line height, and a measure of about 72 characters.</li>
            <li>No justified text, and text can be enlarged to 200% without sideways scrolling.</li>
            <li>Everything works by keyboard alone, with a visible focus indicator and a skip link.</li>
            <li>No flashing, no automatic movement, and no animation at all for anyone who has asked their system to reduce motion.</li>
            <li>Nothing on the site is time-limited.</li>
            <li>Hebrew, Arabic, Russian and English, each in the correct writing direction.</li>
          </ul>

          <h2>Known limitations</h2>
          <ul>
            <li>
              The service information comes from external sources. Some descriptions are written in
              administrative language rather than plain language, and we do not control their wording.
            </li>
            <li>
              Some addresses could not be located precisely. A card whose location is approximate says
              so, but it is still worth confirming by phone before travelling.
            </li>
            <li>
              Smart search depends on an external service. It is an addition only — the ordinary
              search always works and does not depend on it.
            </li>
          </ul>

          <h2>Found a problem?</h2>
          <p>
            If something here is not accessible to you, please tell us. You can open a report in the{' '}
            <a href="https://github.com/zomer-g/social-services-il/issues">project issue tracker</a>, and
            every service page has a "Something wrong here?" button for incorrect content.
          </p>
          <p className="source">This statement was last updated in September 2026.</p>
        </>
      )}
    </article>
  );
}
