export const STORAGE_KEY = "theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Runs before hydration to set the theme class and avoid a flash of the wrong theme. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.classList.toggle("light",!d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
