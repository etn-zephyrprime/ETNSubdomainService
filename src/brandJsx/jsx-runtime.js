import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { withBrandFont } from "./core.js";
export { Fragment };
export const jsxWithBrand = withBrandFont(jsx);
export { jsxWithBrand as jsx };
export const jsxsWithBrand = withBrandFont(jsxs);
export { jsxsWithBrand as jsxs };
