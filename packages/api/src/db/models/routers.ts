import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

export interface RouterAttributes {
	uuid: string;
	name: string;
	location: string;
	publicIp: string | null;
	publicIpv6: string | null;
	wgPublicKey: string | null;
	meshPublicKey: string | null;
	nodeId: number | null;
	provider: string | null;
	dn42Loopback4: string | null;
	dn42Loopback6: string | null;
	maxPeers: number;
	supportsIpv4: boolean;
	supportsIpv6: boolean;
	allowCnPeers: boolean;
	lastSeen: Date | null;
	nodeType: string | null; // 'rr' or 'client' for iBGP topology
	bandwidth: string | null; // Node bandwidth (e.g., '1G', '10G')
	regionCode: number | null; // Region code for communities (101=AS-E, 203=NA-W, 302=EU-C)
	legacyLla: string | null; // Legacy link-local address for existing peer connections
	bootstrapToken: string | null; // Token for bootstrap script generation
	createdAt?: Date;
	updatedAt?: Date;
}

export type RoutersModel = ModelStatic<Model<RouterAttributes>>;

export function initRoutersModel(sequelize: Sequelize): RoutersModel {
	return sequelize.define(
		"routers",
		{
			uuid: {
				type: DataTypes.UUID,
				defaultValue: DataTypes.UUIDV4,
				primaryKey: true,
			},
			name: {
				type: DataTypes.STRING,
				allowNull: false,
				unique: true,
			},
			location: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			publicIp: {
				field: "public_ip",
				type: DataTypes.STRING,
				allowNull: true,
			},
			publicIpv6: {
				field: "public_ipv6",
				type: DataTypes.STRING,
				allowNull: true,
			},
			wgPublicKey: {
				field: "wg_public_key",
				type: DataTypes.STRING,
				allowNull: true,
			},
			meshPublicKey: {
				field: "mesh_public_key",
				type: DataTypes.STRING,
				allowNull: true,
			},
			nodeId: {
				field: "node_id",
				type: DataTypes.INTEGER,
				allowNull: true,
			},
			provider: {
				field: "provider",
				type: DataTypes.STRING,
				allowNull: true,
			},
			dn42Loopback4: {
				field: "dn42_loopback4",
				type: DataTypes.STRING,
				allowNull: true,
			},
			dn42Loopback6: {
				field: "dn42_loopback6",
				type: DataTypes.STRING,
				allowNull: true,
			},

			maxPeers: {
				field: "max_peers",
				type: DataTypes.INTEGER,
				allowNull: false,
				defaultValue: 20,
			},
			supportsIpv4: {
				field: "supports_ipv4",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: true,
			},
			supportsIpv6: {
				field: "supports_ipv6",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: true,
			},
			allowCnPeers: {
				field: "allow_cn_peers",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: true,
			},
			lastSeen: {
				field: "last_seen",
				type: DataTypes.DATE,
				allowNull: true,
			},
			nodeType: {
				field: "node_type",
				type: DataTypes.STRING(10),
				allowNull: true,
			},
			bandwidth: {
				type: DataTypes.STRING(10),
				allowNull: true,
			},
			regionCode: {
				field: "region_code",
				type: DataTypes.INTEGER,
				allowNull: true,
			},
			legacyLla: {
				field: "legacy_lla",
				type: DataTypes.STRING(50),
				allowNull: true,
			},
			bootstrapToken: {
				field: "bootstrap_token",
				type: DataTypes.STRING(32),
				allowNull: true,
				unique: true,
			},
		},
		{
			timestamps: true,
			createdAt: "created_at",
			updatedAt: "updated_at",
			indexes: [{ fields: ["region_code"] }],
		},
	);
}
