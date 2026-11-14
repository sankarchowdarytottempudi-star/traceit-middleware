/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_WEAVE_FACTORY_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
declare module "*.svg?react" {
  import * as React from "react";
  const C: React.FC<React.SVGProps<SVGSVGElement> & { title?: string }>;
  export default C;
}
