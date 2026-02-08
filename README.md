# Deploify

**Track all your deployments in one place without leaving VS Code.**

Deploify brings unified deployment monitoring directly into your VS Code sidebar. Connect your Vercel, Netlify, and AWS Amplify accounts and get real-time updates on your deployment status across all platforms.

## ✨ Features

- 🚀 **Multi-Provider Support**: Monitor Vercel, Netlify, and AWS Amplify deployments in one view
- 🔐 **Secure OAuth**: One-click authentication with Vercel and Netlify (no manual token setup)
- 🌍 **Project Organization**: View workspace-linked projects and all your account projects together
- 🔄 **Auto-Refresh**: Automatic polling keeps your deployment status up-to-date
- 📊 **Deployment History**: See recent deployment history for each environment
- 🔔 **Failure Notifications**: Get notified when deployments fail
- 📱 **Quick Actions**: Open deployments in browser, view details, and manage projects
- 💾 **Secure Storage**: All credentials stored securely in VS Code's SecretStorage

## 🚀 Getting Started

1. **Install the extension** from the VS Code marketplace
2. **Open the Deployments view** from the Activity Bar (rocket icon)
3. **Connect your providers**:
   - Click "Connect Vercel" or "Connect Netlify" for OAuth flow
   - Click "Connect AWS Amplify" to use your AWS credentials
4. **Start monitoring** your deployments!

## 📝 Available Commands

- `Deploify: Connect Provider` - Connect a deployment provider
- `Deploify: Connect Vercel` - Connect Vercel via OAuth
- `Deploify: Connect Netlify` - Connect Netlify via OAuth
- `Deploify: Connect AWS Amplify` - Connect AWS Amplify
- `Deploify: Disconnect Provider` - Disconnect a provider
- `Deploify: Refresh` - Manually refresh deployments
- `Deploify: Open Deployment` - Open deployment in browser
- `Deploify: Open Project Dashboard` - Open project dashboard
- `Deploify: View Details` - View deployment details
- `Deploify: Link Workspace Project` - Link current workspace to a project
- `Deploify: Unlink Workspace Project` - Unlink workspace project

## ⚙️ Settings

Customize Deploify's behavior in your VS Code settings:

- `deploify.pollIntervalSeconds` - Auto-refresh interval (default: 45, min: 20)
- `deploify.notifyOnFailure` - Show notifications for failed deployments (default: true)
- `deploify.providers.vercel.enabled` - Enable/disable Vercel
- `deploify.providers.netlify.enabled` - Enable/disable Netlify
- `deploify.providers.awsAmplify.enabled` - Enable/disable AWS Amplify
- `deploify.providers.awsAmplify.region` - AWS region for Amplify
- `deploify.providers.awsAmplify.profile` - AWS profile to use

## 🤝 Support

Found a bug or have a feature request? [Open an issue](https://github.com/r69shabh/deployify/issues) on GitHub.

## 📄 License

MIT License - see LICENSE file for details.

---

**Enjoy tracking your deployments! 🚀**
