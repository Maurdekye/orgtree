// Offline fixture only. No process, network, registry or credential-store APIs.
using System;
using System.IO;

class SyntheticCredentialTool {
    const string Token = "rig-proof-synthetic-token";
    static string Env(string key) { return Environment.GetEnvironmentVariable(key) ?? ""; }
    static int Main(string[] args) {
        string root = Env("RIG_BROKER_FIXTURE");
        if (root.Length == 0 || !Directory.Exists(root) ||
            Env("HOME") != root || Env("USERPROFILE") != root ||
            Env("GH_CONFIG_DIR") != Path.Combine(root, "gh") ||
            Env("GIT_CONFIG_GLOBAL") != Path.Combine(root, "gitconfig") ||
            Env("GIT_CONFIG_NOSYSTEM") != "1") return 90;
        string tool = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        string host = "";
        string operation = String.Join(" ", args);
        if (tool == "git" && operation == "credential fill") {
            foreach (string line in Console.In.ReadToEnd().Split('\n'))
                if (line.StartsWith("host=")) host = line.Substring(5).TrimEnd('\r');
        } else if (tool == "gh" && args.Length == 4 && args[0] == "auth" &&
                   (args[1] == "token" || args[1] == "status") && args[2] == "--hostname") {
            host = args[3];
        } else return 92;
        if (host != "rig-proof.example" && host != "rig-failure.example") return 93;
        File.AppendAllText(Path.Combine(root, "calls.tsv"), tool + "\t" + operation + "\t" + host + "\n");
        if (host == "rig-failure.example") return 42;
        if (tool == "git") Console.Write("username=rig-proof\npassword=" + Token + "\n\n");
        else if (args[1] == "token") Console.Write(Token);
        else {
            bool bridged = Env("GH_ENTERPRISE_TOKEN") == Token;
            Console.WriteLine(bridged ? "synthetic token received through bridge" : "synthetic native fallback without credentials");
            return bridged ? 0 : 1;
        }
        return 0;
    }
}
