import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { LangSwitch, useSaved } from './components.js';
import { AccessibilityPage } from './accessibility.js';
import { DevelopersPage } from './developers.js';
import { SmartPage } from './smart.js';
import { detectLang, RTL, stringsFor, type Lang } from './i18n.js';
import { HomePage, ResultsPage, SavedPage, ServicePage } from './pages.js';
import { DashboardPage } from './dashboard.js';

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

  const path = location.pathname;
  const section = path.startsWith('/dashboard') ? 'dashboard' : path === '/saved' ? 'saved' : 'search';
  // Results and the dashboard use the full width on a large screen; reading
  // pages keep the narrow measure.
  const wide = path === '/search' || path.startsWith('/dashboard');

  const langLink = (path: string) => `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;

  return (
    <>
      <a className="skip" href="#main">
        {t.skipToContent}
      </a>

      {/* This is not a live service yet, and a directory of helplines is exactly
          the kind of page someone would act on in good faith. The ribbon says so
          above every screen, in words that both sighted readers and screen
          readers get — it replaced a stamp over the content, which said the same
          thing at the cost of making every page harder to read. */}
      <div className="draftribbon" role="note">
        <strong>{t.draftMark}</strong> {t.draftNotice}
      </div>

      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" to={langLink('/')}>
            <span className="brandmark" aria-hidden="true" />
            {t.siteName}
          </Link>
          <nav className="tabs" aria-label={t.siteName}>
            <Link to={langLink('/')} aria-current={section === 'search' ? 'page' : undefined}>
              {t.navSearch}
            </Link>
            <Link to={langLink('/dashboard')} aria-current={section === 'dashboard' ? 'page' : undefined}>
              {t.navDashboard}
            </Link>
            <Link to={langLink('/saved')} aria-current={section === 'saved' ? 'page' : undefined}>
              {t.myFolder}
              {saved.length > 0 && <span className="badge">{saved.length}</span>}
            </Link>
          </nav>
          <LangSwitch lang={lang} onChange={setLang} />
        </div>
      </header>

      <main id="main" className={wide ? 'page wide' : 'page'} tabIndex={-1}>
        <Routes>
          <Route path="/" element={<HomePage lang={lang} />} />
          <Route path="/search" element={<ResultsPage lang={lang} />} />
          <Route path="/s/:cardId" element={<ServicePage lang={lang} />} />
          <Route path="/saved" element={<SavedPage lang={lang} />} />
          <Route path="/smart" element={<SmartPage lang={lang} />} />
          <Route path="/deep" element={<SmartPage lang={lang} deep />} />
          <Route path="/accessibility" element={<AccessibilityPage lang={lang} />} />
          <Route path="/developers" element={<DevelopersPage />} />
          <Route path="/dashboard" element={<DashboardPage lang={lang} />} />
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
