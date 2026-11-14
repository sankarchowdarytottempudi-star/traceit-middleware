declare module "*.svg?react" {
  import * as React from "react";
  const C: React.FC<React.SVGProps<SVGSVGElement> & { title?: string }>;
  export default C;
}
