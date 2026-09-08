import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { LangSwitch, useSaved } from './components.js';
import { AccessibilityPage } from './accessibility.js';
import { DevelopersPage } from './developers.js';
import { SmartPage } from './smart.js';
import { detectLang, RTL, stringsFor, type Lang } from './i18n.js';
import { HomePage, ResultsPage, SavedPage, ServicePage } from './pages.js';

function Shell() {
  const location = useLocation();
  const [lang, setLang] = useState<Lang>(() => detectLang(window.location.search));
  const t = stringsFor(lang);
  const [saved] = useSaved();

  // Direction and language are set on the document rather than a wrapper, so
  // that form controls, scrollbars and the browser's own UI follow too.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
    document.title = t.siteName;
    try {
      localStorage.setItem('lang', lang);
    } catch {
      // Storage may be unavailable; the choice just does not persist.
    }
  }, [lang, t.siteName]);

  // A screen reader gets no announcement from a client-side navigation unless
  // focus is moved, so each page change resets focus to the top of the content.
  //
  // preventScroll matters: focusing the element scrolls it into view, which put
  // the first heading underneath the sticky header and made the page look as if
  // it were missing its title.
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const langLink = (path: string) => `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;

  return (
    <>
      <a className="skip" href="#main">
        {t.skipToContent}
      </a>

      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" to={langLink('/')}>
            {t.siteName}
          </Link>
          <Link className="iconbtn" to={langLink('/saved')} aria-current={location.pathname === '/saved'}>
            {t.myFolder}
            {saved.length > 0 && <span className="badge">{saved.length}</span>}
          </Link>
          <LangSwitch lang={lang} onChange={setLang} />
        </div>
      </header>

      <main id="main" className="page" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<HomePage lang={lang} />} />
          <Route path="/search" element={<ResultsPage lang={lang} />} />
          <Route path="/s/:cardId" element={<ServicePage lang={lang} />} />
          <Route path="/saved" element={<SavedPage lang={lang} />} />
          <Route path="/smart" element={<SmartPage lang={lang} />} />
          <Route path="/deep" element={<SmartPage lang={lang} deep />} />
          <Route path="/accessibility" element={<AccessibilityPage lang={lang} />} />
          <Route path="/developers" element={<DevelopersPage />} />
          <Route path="*" element={<HomePage lang={lang} />} />
        </Routes>

        <footer className="footer">
          <p>{t.disclaimer}</p>
          <nav>
            <Link to={langLink('/developers')}>{t.apiLink}</Link>
            <Link to={langLink('/accessibility')}>{t.a11yLink}</Link>
            <a href="https://github.com/zomer-g/social-services-il">{t.aboutLink}</a>
          </nav>
        </footer>
      </main>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
