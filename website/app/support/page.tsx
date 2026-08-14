export default function Support() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Support</h1>
        <p className="text-gray-300 mb-8">
          Get help with MemOS, UMT, and LLM Guardian.
        </p>

        <h2 className="text-2xl font-semibold mb-4">Discord</h2>
        <p className="text-gray-300 mb-6">
          Join our Discord server for real-time chat with developers and
          users:
        </p>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-8">
          <iframe
            src="https://discord.com/widget?id=YOUR_DISCORD_GUILD_ID&theme=dark"
            width="100%"
            height="500"
            frameBorder="0"
            allowFullScreen
            title="ContextCore Discord"
          />
        </div>

        <h2 className="text-2xl font-semibold mb-4">GitHub Issues</h2>
        <ul className="space-y-3 text-gray-300 mb-8">
          <li>
            <a
              href="https://github.com/Markgatcha/memos/issues"
              className="text-blue-400 hover:underline"
            >
              MemOS Issues
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Markgatcha/universal-mcp-toolkit/issues"
              className="text-purple-400 hover:underline"
            >
              UMT Issues
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Markgatcha/llm-guardian/issues"
              className="text-green-400 hover:underline"
            >
              Guardian Issues
            </a>
          </li>
        </ul>

        <h2 className="text-2xl font-semibold mb-4">Documentation</h2>
        <p className="text-gray-300">
          Full docs at <a href="/docs" className="text-blue-400">context-core.dev/docs</a>
        </p>
      </div>
    </div>
  );
}
