
import { Inter } from "next/font/google"

const inter = Inter({ subsets: ["latin"] })

export const metadata = {
  title: "Trip AI API",
  description: "Travel plan generator",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">

      <body className={inter.className}>{children}</body>
    </html>
  )
}
