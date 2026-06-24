import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

/**
 * RPKI Server Configuration
 */
export interface RpkiServer {
	name: string;
	host: string;
	port: number;
}

/**
 * DN42 Community Definitions
 */
export interface CommunityDefinitions {
	latency: Record<string, [number, number]>;
	bandwidth: Record<string, [number, number]>;
	crypto: Record<string, [number, number]>;
	region: Record<string, [number, number]>;
}

/**
 * MoeNet Large Community Definitions
 */
export interface LargeCommunityDefinitions {
	origin: Record<string, [number, number, number]>;
	subregion: Record<string, [number, number, number]>;
	bandwidth: Record<string, [number, number, number]>;
}

/**
 * BIRD Policy Attributes
 * Stores routing policy configuration that agents use to render BIRD configs
 */
export interface BirdPolicyAttributes {
	id: number;
	name: string; // Policy name (e.g., 'default', 'edge', 'rr')
	dn42As: number; // 4242420998
	dn42Ipv4Prefix: string; // 172.22.188.0/26
	dn42Ipv6Prefix: string; // fd00:4242:7777::/48
	rpkiServers: RpkiServer[]; // RPKI server list
	ebgpImportLimit: number; // eBGP import limit
	ebgpExportLimit: number; // eBGP export limit
	ibgpImportLimit: number; // iBGP import limit
	ibgpExportLimit: number; // iBGP export limit
	asPathMaxLen: number; // Max AS path length
	communities: CommunityDefinitions; // DN42 community definitions
	largeCommunities: LargeCommunityDefinitions; // MoeNet large community definitions
	isDefault: boolean; // Is this the default policy
	createdAt?: Date;
	updatedAt?: Date;
}

export type BirdPoliciesModel = ModelStatic<Model<BirdPolicyAttributes>>;

export function initBirdPoliciesModel(sequelize: Sequelize): BirdPoliciesModel {
	return sequelize.define(
		"bird_policies",
		{
			id: {
				type: DataTypes.INTEGER,
				autoIncrement: true,
				primaryKey: true,
			},
			name: {
				type: DataTypes.STRING(50),
				allowNull: false,
				unique: true,
			},
			dn42As: {
				field: "dn42_as",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 4242420998,
			},
			dn42Ipv4Prefix: {
				field: "dn42_ipv4_prefix",
				type: DataTypes.STRING(20),
				allowNull: false,
				defaultValue: "172.22.188.0/26",
			},
			dn42Ipv6Prefix: {
				field: "dn42_ipv6_prefix",
				type: DataTypes.STRING(30),
				allowNull: false,
				defaultValue: "fd00:4242:7777::/48",
			},
			rpkiServers: {
				field: "rpki_servers",
				type: DataTypes.JSON,
				allowNull: false,
				defaultValue: [{ name: "default", host: "rpki.akae.re", port: 8082 }],
			},
			ebgpImportLimit: {
				field: "ebgp_import_limit",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 10000,
			},
			ebgpExportLimit: {
				field: "ebgp_export_limit",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 5000,
			},
			ibgpImportLimit: {
				field: "ibgp_import_limit",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 20000,
			},
			ibgpExportLimit: {
				field: "ibgp_export_limit",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 30000,
			},
			asPathMaxLen: {
				field: "as_path_max_len",
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				defaultValue: 5,
			},
			communities: {
				type: DataTypes.JSON,
				allowNull: false,
				defaultValue: {
					latency: {
						tier0: [64511, 1],
						tier1: [64511, 2],
						tier2: [64511, 3],
						tier3: [64511, 4],
						tier4: [64511, 5],
						tier5: [64511, 6],
						tier6: [64511, 7],
						tier7: [64511, 8],
						tier8: [64511, 9],
					},
					bandwidth: {
						"100m_plus": [64511, 21],
						"10g_plus": [64511, 22],
						"1g_plus": [64511, 23],
						"100k_plus": [64511, 24],
						"10m_plus": [64511, 25],
					},
					crypto: {
						none: [64511, 31],
						unsafe: [64511, 32],
						encrypted: [64511, 33],
						latency: [64511, 34],
					},
					region: {
						eu: [64511, 41],
						na_e: [64511, 42],
						na_c: [64511, 43],
						na_w: [64511, 44],
						ca: [64511, 45],
						sa: [64511, 46],
						af: [64511, 47],
						as_s: [64511, 48],
						as_se: [64511, 49],
						as_e: [64511, 50],
						oc: [64511, 51],
						me: [64511, 52],
						as_n: [64511, 53],
					},
				},
			},
			largeCommunities: {
				field: "large_communities",
				type: DataTypes.JSON,
				allowNull: false,
				defaultValue: {
					origin: {
						as: [4242420998, 1, 100],
						na: [4242420998, 1, 200],
						eu: [4242420998, 1, 300],
						oc: [4242420998, 1, 400],
					},
					subregion: {
						as_e: [4242420998, 2, 101],
						as_se: [4242420998, 2, 102],
						as_s: [4242420998, 2, 103],
						as_n: [4242420998, 2, 104],
						na_e: [4242420998, 2, 201],
						na_c: [4242420998, 2, 202],
						na_w: [4242420998, 2, 203],
						eu_w: [4242420998, 2, 301],
						eu_c: [4242420998, 2, 302],
						oc: [4242420998, 2, 401],
					},
					bandwidth: {
						"10g": [4242420998, 5, 10000],
						"5g": [4242420998, 5, 5000],
						"2g": [4242420998, 5, 2000],
						"1g": [4242420998, 5, 1000],
						"500m": [4242420998, 5, 500],
						"200m": [4242420998, 5, 200],
						"100m": [4242420998, 5, 100],
						"50m": [4242420998, 5, 50],
						"10m": [4242420998, 5, 10],
					},
				},
			},
			isDefault: {
				field: "is_default",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: false,
			},
		},
		{
			timestamps: true,
			createdAt: "created_at",
			updatedAt: "updated_at",
			indexes: [{ fields: ["name"] }, { fields: ["is_default"] }],
		},
	);
}
