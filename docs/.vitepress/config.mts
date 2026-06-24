import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    title: 'MoeNet DN42',
    description: 'Documentation for MoeNet DN42 Network — Control Plane & Agent',
    lang: 'en-US',

    head: [
      ['meta', { name: 'theme-color', content: '#6366f1' }],
    ],

    themeConfig: {
      nav: [
        { text: 'Guide', link: '/guide/overview' },
        { text: 'API', link: '/api/authentication' },
        { text: 'Operations', link: '/operations/deployment' },
        { text: 'Reference', link: '/reference/database' },
        {
          text: 'Code Docs',
          items: [
            { text: 'moenet-core (DeepWiki)', link: 'https://deepwiki.com/heichaowo/moenet-core' },
            { text: 'moenet-agent (DeepWiki)', link: 'https://deepwiki.com/heichaowo/moenet-agent' },
          ],
        },
      ],

      sidebar: {
        '/guide/': [
          {
            text: 'Guide',
            items: [
              { text: 'Overview', link: '/guide/overview' },
              { text: 'Getting Started', link: '/guide/getting-started' },
              { text: 'Network Topology', link: '/guide/network-topology' },
            ],
          },
        ],
        '/api/': [
          {
            text: 'API Reference',
            items: [
              { text: 'Authentication', link: '/api/authentication' },
              { text: 'Peering', link: '/api/peering' },
              { text: 'Agent Protocol', link: '/api/agent' },
              { text: 'Admin', link: '/api/admin' },
              { text: 'Bot Commands', link: '/api/bot-commands' },
            ],
          },
        ],
        '/operations/': [
          {
            text: 'Operations',
            items: [
              { text: 'Deployment', link: '/operations/deployment' },
              { text: 'Configuration', link: '/operations/configuration' },
              { text: 'Monitoring', link: '/operations/monitoring' },
              { text: 'Troubleshooting', link: '/operations/troubleshooting' },
            ],
          },
        ],
        '/reference/': [
          {
            text: 'Reference',
            items: [
              { text: 'Database Schema', link: '/reference/database' },
              { text: 'BGP Communities', link: '/reference/communities' },
              { text: 'Agent Config', link: '/reference/agent-config' },
            ],
          },
        ],
      },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/heichaowo/moenet-core' },
      ],

      search: {
        provider: 'local',
      },

      editLink: {
        pattern: 'https://github.com/heichaowo/moenet-core/edit/main/docs/:path',
        text: 'Edit this page on GitHub',
      },

      footer: {
        message: 'MoeNet DN42 Network — AS4242420998',
        copyright: 'MIT License',
      },
    },
  })
)
