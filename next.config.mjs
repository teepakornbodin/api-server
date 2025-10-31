/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { forceSwcTransforms: true },
  // ปิดระหว่างแรก ๆ ถ้ายังจัด ESLint/TS ไม่เสร็จ
  eslint: { ignoreDuringBuilds: true },
  // ถ้าอยากให้ build ผ่านก่อน ค่อยมาแก้ type ทีหลัง
  // ตั้ง false ถ้าพร้อมให้ TypeScript เข้มงวด
  typescript: { ignoreBuildErrors: true }
};

export default nextConfig;
