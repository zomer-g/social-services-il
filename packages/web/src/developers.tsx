import { useState } from 'react';

/**
 * The developer page, in Hebrew.
 *
 * MCP comes first because it is the shortest route from "I have a question" to
 * an answer: no key, no code, and the assistant does the searching. The REST
 * endpoints follow for anyone building software.
 *
 * Written directly rather than generated from the OpenAPI document. The machine
 * contract stays at /api/openapi.json and is what tools should read; this page
 * is for a person deciding whether the data is useful to them, and that is a
 * different piece of writing.
 */

const BASE = typeof window === 'undefined' ? '' : window.location.origin;

function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'הועתק' : 'העתק'}
    </button>
  );
}

function Endpoint({
  method = 'GET',
  path,
  title,
  children,
  params,
  example,
}: {
  method?: string;
  path: string;
  title: string;
  children?: React.ReactNode;
  params?: [string, string][];
  example?: string;
}) {
  return (
    <article className="endpoint">
      <h3>
        <span className={`method ${method.toLowerCase()}`}>{method}</span>
        <code dir="ltr">{path}</code>
      </h3>
      <p className="summary">{title}</p>
      {children}
      {params && params.length > 0 && (
        <dl className="params">
          {params.map(([name, description]) => (
            <div key={name}>
              <dt>
                <code dir="ltr">{name}</code>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      )}
      {example && (
        <p className="example">
          דוגמה:{' '}
          <a href={example} target="_blank" rel="noreferrer noopener" dir="ltr">
            {example}
          </a>{' '}
          <span className="muted">(נפתח בחלון חדש)</span>
        </p>
      )}
    </article>
  );
}

const MCP_URL = `${BASE}/mcp`;

const MCP_TOOLS = [
  ['search_services', 'חיפוש שירותים בטקסט חופשי, לפי קטגוריה, לפי עיר או לפי נקודת ציון'],
  ['find_services_near', 'השירותים הקרובים ביותר לנקודה, לפי מרחק'],
  ['get_service', 'כל מה שידוע על שירות אחד במקום אחד'],
  ['find_taxonomy', 'תרגום של צורך במילים למזהי קטגוריה'],
  ['list_taxonomy', 'עיון בעץ הקטגוריות'],
  ['get_organization', 'ארגון וכל השירותים שהוא מפעיל'],
  ['emergency_lines', 'קווי חירום ארציים שעונים מיד'],
  ['corpus_stats', 'כמה נתונים יש ומתי עודכנו'],
];

export function DevelopersPage() {
  return (
    <div className="devdocs">
      <h1>ממשק תכנותי (API)</h1>
      <p className="lede">
        גישה פתוחה לכל השירותים החברתיים שבאתר — ב־MCP לסוכני AI, וב־REST לתוכנה.
      </p>

      <h2>בקצרה</h2>
      <p>
        העמוד הזה מסביר איך לקבל את הנתונים של האתר ישירות לתוכנה או לעוזר ה־AI שלכם, בלי לעבור דרך
        הדפדפן. <strong>אין צורך בהרשמה ואין צורך במפתח</strong> לקריאה. כל כתובת בעמוד מחזירה נתונים
        בפורמט שתוכנות קוראות; אפשר להעתיק אותה ולהדביק בדפדפן כדי לראות מה מגיע.
      </p>
      <p>
        המידע כולו ציבורי — שירותים חברתיים שעמותות, משרדי ממשלה ורשויות מקומיות מעמידים לרשות
        הציבור. השימוש פתוח לחוקרים, עיתונאים, עובדים סוציאליים, ארגונים ופרויקטים אזרחיים. אם אתם
        בונים אינטגרציה רחבה — נא להימנע ממיליוני קריאות מקבילות ולשמור מטמון מקומי.
      </p>

      {/* ---------------------------------------------------------------- MCP */}

      <h2 id="mcp">MCP — חיבור ישיר ל‑Claude, ChatGPT, Cursor וסוכני AI</h2>
      <p>
        גישה מובנית לנתונים דרך <span dir="ltr">Model Context Protocol</span> — ה‑AI מחפש ומושך
        נתונים מתוך השיחה, בלי לעבור דרך ה‑API הציבורי ובלי שתכתבו שורת קוד. שרת אחד, שמונה כלים,{' '}
        <strong>ללא אימות</strong>.
      </p>

      <div className="mcpcard">
        <div className="mcpurl">
          <code dir="ltr">{MCP_URL}</code>
          <Copy text={MCP_URL} />
        </div>
        <ul className="toollist">
          {MCP_TOOLS.map(([name, description]) => (
            <li key={name}>
              <code dir="ltr">{name}</code>
              <span>{description}</span>
            </li>
          ))}
        </ul>
      </div>

      <p>
        השרת מספק גם שני משאבים — <code dir="ltr">taxonomy://responses</code> ו־
        <code dir="ltr">taxonomy://situations</code>, עצי הקטגוריות המלאים — ופרומפט מובנה בשם{' '}
        <code dir="ltr">find-help</code> שמוביל מתיאור מצב של אדם עד לרשימת שירותים שאפשר להתקשר
        אליהם.
      </p>

      <h3>איך מתחברים מ‑Claude</h3>
      <ol className="steps">
        <li>
          ב‑Claude (דסקטופ או <span dir="ltr">claude.ai</span>) פתחו <strong>Settings → Connectors</strong>{' '}
          ולחצו <strong>Add custom connector</strong>.
        </li>
        <li>
          ב‑<strong>Name</strong> כתבו שם שתזהו — למשל "שירותים חברתיים" — וב‑<strong>Server URL</strong>{' '}
          הדביקו את הכתובת שלמעלה.
        </li>
        <li>
          לחצו <strong>Connect</strong>. אין מסך התחברות ואין הרשאות לאשר: הנתונים ציבוריים והשרת
          לקריאה בלבד.
        </li>
        <li>
          ה‑connector יסומן <strong>Connected</strong>, ובסרגל הכלים של השיחה יופיעו שמונה הפעולות.
          מכאן אפשר לשאול בשפה חופשית — למשל "איפה יש חלוקת סלי מזון קרוב לרמלה, ומה מספר הטלפון".
        </li>
      </ol>

      <h3>איך מתחברים מ‑Claude Code</h3>
      <div className="codeblock">
        <Copy text={`claude mcp add --transport http social-services ${MCP_URL}`} />
        <pre dir="ltr">
          <code>{`claude mcp add --transport http social-services ${MCP_URL}`}</code>
        </pre>
      </div>

      <h3>איך מתחברים מ‑Cursor או מכל לקוח MCP אחר</h3>
      <p>
        הוסיפו את השרת לקובץ ההגדרות של הלקוח כשרת מסוג <span dir="ltr">HTTP</span> (לעיתים מסומן{' '}
        <span dir="ltr">streamable-http</span>):
      </p>
      <div className="codeblock">
        <Copy
          text={JSON.stringify(
            { mcpServers: { 'social-services': { type: 'http', url: MCP_URL } } },
            null,
            2,
          )}
        />
        <pre dir="ltr">
          <code>
            {JSON.stringify(
              { mcpServers: { 'social-services': { type: 'http', url: MCP_URL } } },
              null,
              2,
            )}
          </code>
        </pre>
      </div>

      <div className="callout">
        <p>
          <strong>המידע עשוי להיות לא מעודכן.</strong> כל תשובה מהשרת כוללת שדה{' '}
          <code dir="ltr">last_updated</code>. כשאתם מוסרים שירות לאדם — מסרו את מספר הטלפון ואת תאריך
          העדכון, כדי שיוכל לוודא לפני שהוא יוצא לדרך.
        </p>
      </div>

      {/* --------------------------------------------------------- המודל */}

      <h2 id="model">איך הנתונים בנויים</h2>
      <p>
        <strong>שירות</strong> הוא מה שמוצע. <strong>ארגון</strong> הוא מי שמפעיל אותו.{' '}
        <strong>סניף</strong> הוא המקום שבו הוא ניתן. <strong>כרטיס</strong> הוא שירות אחד במקום אחד
        — וזה מה שהחיפוש מחזיר ומה שהאתר מקשר אליו.
      </p>
      <p>
        השירותים מתוארים על שני צירים. <strong>מענה</strong> (<span dir="ltr">response</span>) הוא מה
        שהשירות נותן, ו<strong>מצב</strong> (<span dir="ltr">situation</span>) הוא למי הוא מיועד.
        המזהים היררכיים ומופרדים בנקודתיים, למשל{' '}
        <code dir="ltr">human_services:food:food_pantry</code>. סינון לפי צומת אב מחזיר גם את כל מה
        שמתחתיו — כך ש־<code dir="ltr">human_services:food</code> מחזיר גם שירותים שתויגו רק{' '}
        <code dir="ltr">human_services:food:food_pantry</code>.
      </p>
      <p>
        שירות שאין לו מקום פיזי מסומן <code dir="ltr">national_service</code>. זו עובדה על השירות ולא
        נתון חסר: הוא זמין בכל הארץ. חיפוש ברדיוס או בתחום מפה תמיד יכלול שירותים כאלה.
      </p>
      <p>
        <code dir="ltr">location_accurate</code> הוא <span dir="ltr">false</span> כשהנקודה על המפה היא
        מרכז היישוב ולא הכתובת עצמה. כדאי להציג את זה ולא להעמיד פנים שיש דיוק שאין.
      </p>

      {/* ---------------------------------------------------------- REST */}

      <h2 id="rest">נקודות קצה — REST</h2>
      <p>
        כל נקודות הקצה לקריאה פתוחות, ללא מפתח, עם <span dir="ltr">CORS</span> פתוח. כתובת הבסיס היא{' '}
        <code dir="ltr">/api/v1</code>. התיעוד המכונתי המלא (<span dir="ltr">OpenAPI 3.1</span>) זמין ב־
        <a href="/api/openapi.json" dir="ltr">
          /api/openapi.json
        </a>
        .
      </p>

      <h3>חיפוש</h3>

      <Endpoint
        path="/api/v1/search"
        title="חיפוש שירותים — טקסט חופשי, קטגוריות, מיקום ועיר, עם ספירות סינון."
        params={[
          ['q', 'טקסט חופשי בעברית. מותאם מול שמות שירותים, תיאורים וסינונימים של קטגוריות, עם טיפול בתחיליות והתאמה גם לשגיאות כתיב.'],
          ['response', 'מזהי מענה. ניתן לחזור על הפרמטר או להפריד בפסיקים. כולל צאצאים.'],
          ['situation', 'מזהי מצב. אותה התנהגות.'],
          ['lat, lon', 'נקודת ציון. מדרג לפי קרבה ומחזיר מרחק בכל תוצאה.'],
          ['radius_km', 'רדיוס בקילומטרים. שירותים ארציים נכללים תמיד.'],
          ['bbox', 'תחום מפה: מערב,דרום,מזרח,צפון.'],
          ['city', 'שם עיר מדויק כפי שהוא מופיע בנתונים.'],
          ['national_service', 'only — רק שירותים ארציים. exclude — רק מקומיים.'],
          ['collapse', 'ברירת מחדל true: מאחד שירותים זהים שניתנים במקומות רבים לשורה אחת. false מחזיר כל כרטיס בנפרד.'],
          ['limit, offset', 'עימוד. limit עד 100, ברירת מחדל 20.'],
          ['lang', 'he | ar | ru | en — שפת שמות הקטגוריות בתשובה.'],
        ]}
        example={`${BASE}/api/v1/search?q=${encodeURIComponent('סל מזון')}&city=${encodeURIComponent('ירושלים')}`}
      >
        <p>
          התשובה כוללת <code dir="ltr">total</code> (מספר התוצאות בכל התוצאה, לא בעמוד),{' '}
          <code dir="ltr">cards</code>, ו־<code dir="ltr">facets</code> — ספירות לפי מענה, מצב ועיר,
          שמחושבות על כל התוצאה כך שהן נשארות נכונות גם בעמוד הרביעי.
        </p>
      </Endpoint>

      <Endpoint
        path="/api/v1/autocomplete"
        title="הצעות תוך כדי הקלדה — קטגוריות ושירותים בשמם."
        params={[
          ['q', 'הטקסט שהוקלד עד כה (חובה).'],
          ['lang', 'שפת ההצעות.'],
          ['limit', 'ברירת מחדל 8, עד 25.'],
        ]}
        example={`${BASE}/api/v1/autocomplete?q=${encodeURIComponent('מזו')}`}
      >
        <p>
          מוחזרות שתי רשימות, כי אנשים מקלידים שני דברים שונים: צורך ("מזון") שמתאים לקטגוריה, ושם
          ("לתת") שמתאים לשירות מסוים. קטגוריות ללא שירותים מאחוריהן אינן מוצעות.
        </p>
      </Endpoint>

      <h3>רשומות</h3>

      <Endpoint
        path="/api/v1/cards/{cardId}"
        title="שירות אחד במקום אחד — כולל תנאים, עלות, דרכי פנייה ושאר השירותים באותו סניף."
        example={`${BASE}/api/v1/search?limit=1`}
      />

      <Endpoint
        path="/api/v1/organizations/{id}"
        title="ארגון וכל השירותים שהוא מפעיל. המזהה הוא מספר העמותה או החברה כשקיים."
      />

      <Endpoint
        path="/api/v1/taxonomy"
        title="עץ הקטגוריות, עם מספר השירותים תחת כל צומת והסינונימים שלה."
        params={[
          ['axis', 'response | situation. ללא הפרמטר — שני הצירים.'],
          ['lang', 'שפת השמות.'],
          ['include_empty', 'ברירת מחדל false: קטגוריות שאין מאחוריהן שירותים מוסתרות.'],
        ]}
        example={`${BASE}/api/v1/taxonomy?axis=response`}
      />

      <h3>כלל הנתונים</h3>

      <Endpoint
        path="/api/v1/export/cards.ndjson"
        title="כל השירותים, שורה אחת של JSON לכל כרטיס."
        params={[
          ['updated_since', 'תאריך בפורמט ISO. מחזיר רק מה שהשתנה מאז — כדי לתחזק עותק מקומי בלי להוריד הכל מחדש בכל פעם.'],
        ]}
        example={`${BASE}/api/v1/export/cards.ndjson?updated_since=2026-01-01T00:00:00Z`}
      />

      <Endpoint
        path="/api/v1/stats"
        title="כמה שירותים, ארגונים, סניפים וערים יש, ומתי עודכן המידע לאחרונה."
        example={`${BASE}/api/v1/stats`}
      />

      <h3>דיווח על טעות</h3>

      <Endpoint
        method="POST"
        path="/api/v1/feedback"
        title="דיווח על מידע שגוי. ללא מפתח וללא הרשמה."
        params={[
          ['card_id', 'מזהה הכרטיס שהדיווח מתייחס אליו.'],
          ['kind', 'error | closed | wrong_phone | wrong_address | other'],
          ['message', 'מה לא נכון (חובה).'],
          ['contact', 'אופציונלי, רק אם רוצים שנחזור אליכם.'],
        ]}
      >
        <p>
          מי שהתקשר לטלפון מנותק הוא היחיד שיודע שהוא מנותק. הדיווח נכנס לתור טיפול בממשק הניהול.
        </p>
      </Endpoint>

      {/* -------------------------------------------------------- כתיבה */}

      <h2 id="write">כתיבה — דחיפה ועדכון של שירותים</h2>
      <p>
        ארגון שרוצה שהשירותים שלו יופיעו יכול לדחוף אותם ישירות. נדרש מפתח API עם ההרשאה{' '}
        <code dir="ltr">ingest:write</code>, שנשלח ככותרת{' '}
        <code dir="ltr">Authorization: Bearer &lt;key&gt;</code>. לקבלת מפתח פנו למנהלי המערכת.
      </p>
      <p>
        הזיהוי הוא לפי <code dir="ltr">external_id</code> שלכם יחד עם המקור שאליו המפתח משויך — כך
        שדחיפה חוזרת של אותן שורות מעדכנת ואינה מכפילה, וריצה שנקטעה באמצע אינה יוצרת כפילויות.
      </p>

      <Endpoint
        method="POST"
        path="/api/v1/ingest/services"
        title="יצירה או עדכון של שירותים, עד 500 בבקשה."
        params={[
          ['dry_run', 'true מחזיר בדיוק מה היה קורה, בלי לכתוב כלום. מומלץ לפני החיבור הראשון.'],
          ['services[]', 'מערך שירותים. לכל שירות: external_id, name, responses (לפחות אחד), organization, ואופציונלית branches.'],
        ]}
      >
        <p>
          השגיאות מדווחות <strong>לכל פריט בנפרד</strong>: אצווה של מאתיים שירותים עם טלפון שגוי אחד
          כותבת את מאה תשעים ותשעה האחרים ומציינת בדיוק מי נכשל. תיוג שאינו קיים בעץ הקטגוריות נזרק
          ומדווח ב־<code dir="ltr">warnings</code>, אבל שירות שנשאר בלי אף מענה נדחה — כי הוא היה קיים
          ובלתי נגיש.
        </p>
        <p>
          אם השירות מתפרסם מיד או ממתין לאישור אנושי תלוי ברמת האמון של המקור שאליו המפתח משויך.
          התשובה אומרת במפורש מה קרה, בשדה <code dir="ltr">published_immediately</code>.
        </p>
      </Endpoint>

      <Endpoint
        method="GET"
        path="/api/v1/ingest/whoami"
        title="מה המפתח שלכם מורשה לעשות, ולאיזה מקור הוא משויך. הקריאה הראשונה שכדאי לעשות."
      />

      <Endpoint
        method="DELETE"
        path="/api/v1/ingest/services/{externalId}"
        title="הסרת שירות. הרשומה עוברת לארכיון ואינה נמחקת, וההיסטוריה נשמרת."
      />

      <h2>רישוי</h2>
      <p>
        הקוד של הפרויקט פתוח ברישיון MIT ונמצא ב־
        <a href="https://github.com/zomer-g/social-services-il">GitHub</a>. הנתונים עצמם הם מידע ציבורי
        שמפרסמים עמותות, משרדי ממשלה ורשויות מקומיות, וכל רשומה נושאת את מקורה.
      </p>
    </div>
  );
}
