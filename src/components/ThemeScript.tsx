/**
 * Inlined in <head> so the correct theme class is applied before first paint,
 * preventing a flash of the wrong theme. Reads the saved preference, falling
 * back to the OS color scheme. Mirrors the key used by the Zustand store.
 */
import { THEME_KEY } from "@/lib/constants";

export function ThemeScript() {
  const code = `(function(){try{
    var t = localStorage.getItem('${THEME_KEY}');
    if(t !== 'light' && t !== 'dark'){
      t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.toggle('dark', t === 'dark');
  }catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
