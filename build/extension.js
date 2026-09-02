const path = require('path')
const webpack = require('webpack')
const { merge } = require('webpack-merge')
const common = require('./common')
const { resolveEnvironment } = require('./environments')

const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyPlugin = require('copy-webpack-plugin')
const ZipPlugin = require('zip-webpack-plugin')

module.exports = (env={}, args={}) => {
    const buildEnvironment = resolveEnvironment(env)
    const outputDirectory = buildEnvironment.name == 'local' ? 'dev' : buildEnvironment.name == 'production' ? 'prod' : buildEnvironment.name
    const outputPath = path.resolve(__dirname, '..', 'dist', env.vendor, outputDirectory)

    env.filename = '[name]'
    env.environment = buildEnvironment.name
    env.apiOrigin = buildEnvironment.apiOrigin
    env.aiPageOrigin = buildEnvironment.aiPageOrigin
    env.appOrigin = buildEnvironment.appOrigin

    //prevent mv3 review issues with remote code
    env.sentry = { disabled: true }

    return merge(
        common(env, args),
        {
            //prevent mv3 review issues with remote code
            resolve: {
                alias: {
                    'recaptcha-v3': false,
                    //Replace lodash-es/_root.js that uses `Function('return this')()`
                    [path.resolve(__dirname, '../node_modules/lodash-es/_root.js')]: path.resolve(__dirname, 'polyfills/_root.js'),
                    [path.resolve(__dirname, '../node_modules/core-js/internals/global.js')]: path.resolve(__dirname, 'polyfills/core-js-global.js')
                }
            },

            devtool: false, //extensions just ignore .map files

            entry: {
                manifest: './target/extension/manifest/index.js',
                background: './target/extension/background/index.js'
            },

            output: {
                path: outputPath,
                filename: ({ chunk: { name } }) => name=='background' ? 'background.js' : `assets/${env.filename}.js`,
                chunkFilename: `assets/${env.filename}.js`,
                publicPath: '',
                globalObject: 'globalThis',
                environment: { globalThis: true }
            },

            performance: {
                hints: false //because generated zip always big
            },

            optimization: {
                runtimeChunk: false
            },

            devServer: {
                devMiddleware: {
                    writeToDisk: true
                },
            },

            plugins: [
                ...[
                    'sidepanel.html',
                    ...(env.vendor == 'chrome' ? ['newtab.html'] : [])
                ].map(filename=>new HtmlWebpackPlugin({
                    title: 'Raindrop.io',
                    template: './index.ejs',
                    templateParameters: {
						apiOrigin: buildEnvironment.apiOrigin,
						aiPageOrigin: buildEnvironment.aiPageOrigin,
						appOrigin: buildEnvironment.appOrigin,
						turnstileSiteKey: buildEnvironment.turnstileSiteKey,
						turnstileEnabled: buildEnvironment.turnstileEnabled
                    },
                    filename,
                    scriptLoading: 'blocking',
                    inject: 'body',
                    excludeChunks: ['manifest', 'background']
                })),

                new webpack.DefinePlugin({
                    'process.env.APP_TARGET': JSON.stringify('extension'),
                    'process.env.EXTENSION_VENDOR': JSON.stringify(env.vendor)
                }),

                new CopyPlugin({
                    patterns: [
                        { from: 'assets/target/extension/welcome', to: 'welcome' }
                    ]
                }),

                ...(env.production ? [
                    new ZipPlugin({
                        path: '../../',
                        filename: `${env.vendor}-${env.production?'prod':'dev'}.zip`,
                        exclude: []
                    })
                ] : [])
            ],

            module: {
                rules: [{
                    test: /manifest\/index\.js$/,
                    use: [
                        {
                            loader: 'file-loader',
                            options: {
                                name: 'manifest.json'
                            }
                        },
                        {
                            loader: 'val-loader',
                            options: env
                        }
                    ]
                }]
            }
        }
    )
}
