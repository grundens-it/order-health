// Vite resolves image imports to an emitted URL string. tsconfig pins `types` to
// ["node"], so vite/client's ambient asset declarations are not picked up
// automatically; declare the asset modules we actually import.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
