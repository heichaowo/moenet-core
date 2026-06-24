import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

/**
 * BGP Session Status
 * Matches iedon's status codes
 */
export enum PeeringStatus {
	DISABLED = 1,
	ENABLED = 2,
	PENDING_REVIEW = 3,
	QUEUED_FOR_SETUP = 4,
	QUEUED_FOR_DELETE = 5,
	PROBLEM = 6,
	TEARDOWN = 7,
	REJECTED = 8,
}

/**
 * BGP Session Policy
 */
export enum SessionPolicy {
	FULL = 0, // Transit: send and recv all valid
	PEER = 1, // Peer: send own, recv their owned
	UPSTREAM = 2, // Upstream: send all valid, recv their owned
	DOWNSTREAM = 3, // Downstream: send own, recv all valid
}

export interface BgpSessionAttributes {
	uuid: string;
	router: string;
	asn: number;
	status: PeeringStatus;
	mtu: number;
	policy: SessionPolicy;
	ipv4: string | null;
	ipv6: string | null;
	ipv6LinkLocal: string | null;
	localIpv4: string | null;
	type: string;
	extensions: string | null;
	interface: string;
	endpoint: string | null;
	credential: string | null;
	data: string | null;
	contact: string | null;
	lastError: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

export type BgpSessionsModel = ModelStatic<Model<BgpSessionAttributes>>;

export function initBgpSessionsModel(sequelize: Sequelize): BgpSessionsModel {
	return sequelize.define(
		"bgp_sessions",
		{
			uuid: {
				type: DataTypes.UUID,
				defaultValue: DataTypes.UUIDV4,
				primaryKey: true,
			},
			router: {
				type: DataTypes.UUID,
				allowNull: false,
			},
			asn: {
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
			},
			status: {
				type: DataTypes.TINYINT.UNSIGNED,
				allowNull: false,
				defaultValue: PeeringStatus.PENDING_REVIEW,
			},
			mtu: {
				type: DataTypes.SMALLINT.UNSIGNED,
				allowNull: false,
				defaultValue: 1420,
			},
			policy: {
				type: DataTypes.TINYINT.UNSIGNED,
				allowNull: false,
				defaultValue: SessionPolicy.FULL,
			},
			ipv4: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			ipv6: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			ipv6LinkLocal: {
				field: "ipv6_link_local",
				type: DataTypes.STRING,
				allowNull: true,
			},
			localIpv4: {
				field: "local_ipv4",
				type: DataTypes.STRING,
				allowNull: true,
			},
			type: {
				type: DataTypes.STRING,
				allowNull: false,
				defaultValue: "wireguard",
			},
			extensions: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			interface: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			endpoint: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			credential: {
				type: DataTypes.TEXT,
				allowNull: true,
			},
			data: {
				type: DataTypes.TEXT,
				allowNull: true,
			},
			contact: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			lastError: {
				field: "last_error",
				type: DataTypes.STRING,
				allowNull: true,
			},
		},
		{
			timestamps: true,
			createdAt: "created_at",
			updatedAt: "updated_at",
			indexes: [
				{ fields: ["router"] },
				{ fields: ["asn"] },
				{ unique: true, fields: ["router", "asn"] },
			],
		},
	);
}
