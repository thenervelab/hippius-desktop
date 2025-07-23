# Hippius Desktop App

Hippius is a desktop application built with Next.js and Tauri for monitoring IPFS node status and blockchain performance. This application provides insights into network connections, node status, file storage, and blockchain metrics.

## 🚀 Technologies

- **Frontend**: Next.js 15, React 19, TailwindCSS
- **Desktop**: Tauri 2.0
- **State Management**: Jotai
- **Data Visualization**: Visx, React Circular Progressbar
- **UI Components**: Radix UI

## ⚙️ Prerequisites

Before you begin, make sure you have the following installed:

- Node.js (v18 or newer)
- pnpm (v9.12.3 or newer)
- Rust (for Tauri)
- Additional Tauri dependencies based on your OS:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio with C++ build tools
  - **Linux**: Various development packages (see [Tauri prerequisites](https://tauri.app/v2/guides/getting-started/prerequisites))

## 📦 Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/hippius-desktop.git
cd hippius-desktop
```

2. Install dependencies using pnpm:

```bash
pnpm install
```

3. Set up environment variables:

Create a `.env.local` file in the root directory and configure your environment variables.

## 🧑‍💻 Development

### Web Development

To start the Next.js development server:

```bash
pnpm dev
```

This will start the development server at `http://localhost:3000`.

### Desktop Development

To develop the Tauri desktop application:

```bash
pnpm tauri dev
```

This command will start both the Next.js development server and the Tauri window that loads the web app.

## 🏗️ Building for Production

### Web Build

To create a production build for web deployment:

```bash
pnpm build
```

This will generate static files in the `out` directory.

### Desktop Build

To build the desktop application:

```bash
pnpm tauri build
```

This will create platform-specific installers in the `src-tauri/target/release/bundle` directory.

## 📁 Project Structure

```
hippius-desktop/
├── app/                # Next.js app directory with pages and components
├── components/         # Shared React components
├── lib/                # Utility functions and shared logic
├── public/             # Static files
├── src-tauri/          # Tauri-specific code (Rust)
│   ├── src/            # Rust source code
│   └── tauri.conf.json # Tauri configuration
└── package.json        # Project dependencies and scripts
```

## 🧪 Testing

Run tests with:

```bash
pnpm test
```

## 🔑 Features

- Real-time IPFS node monitoring
- Blockchain status and metrics
- File management and storage analytics
- Network connection tracking
- Upload/Download speed monitoring
- Credit usage visualization

## 📄 License

[MIT](LICENSE)

## 🙏 Acknowledgements

- [Next.js](https://nextjs.org/)
- [Tauri](https://tauri.app/)
- [Polkadot.js](https://polkadot.js.org/)
- [TailwindCSS](https://tailwindcss.com/)
