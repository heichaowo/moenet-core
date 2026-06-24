import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

export interface AuditLogAttributes {
	id?: number; // Auto-generated
	action: string; // e.g., 'session.create', 'user.login', 'admin.approve'
	actorType: string; // 'user', 'admin', 'system', 'agent'
	actorId: string; // User ASN, admin ID, or 'system'
	targetType: string | null; // 'session', 'user', 'router', etc.
	targetId: string | null;
	metadata: string | null; // JSON string with additional context
	ip: string | null;
	userAgent: string | null;
	requestId: string | null;
	createdAt?: Date;
}

export type AuditLogsModel = ModelStatic<Model<AuditLogAttributes>>;

export function initAuditLogsModel(sequelize: Sequelize): AuditLogsModel {
	return sequelize.define(
		"audit_logs",
		{
			id: {
				type: DataTypes.INTEGER,
				primaryKey: true,
				autoIncrement: true,
			},
			action: {
				type: DataTypes.STRING(100),
				allowNull: false,
			},
			actorType: {
				field: "actor_type",
				type: DataTypes.STRING(20),
				allowNull: false,
			},
			actorId: {
				field: "actor_id",
				type: DataTypes.STRING(50),
				allowNull: false,
			},
			targetType: {
				field: "target_type",
				type: DataTypes.STRING(50),
				allowNull: true,
			},
			targetId: {
				field: "target_id",
				type: DataTypes.STRING(50),
				allowNull: true,
			},
			metadata: {
				type: DataTypes.TEXT,
				allowNull: true,
			},
			ip: {
				type: DataTypes.STRING(45), // IPv6 max length
				allowNull: true,
			},
			userAgent: {
				field: "user_agent",
				type: DataTypes.STRING(255),
				allowNull: true,
			},
			requestId: {
				field: "request_id",
				type: DataTypes.STRING(50),
				allowNull: true,
			},
		},
		{
			timestamps: true,
			createdAt: "created_at",
			updatedAt: false, // Audit logs are immutable
			indexes: [
				{ fields: ["action"] },
				{ fields: ["actor_id"] },
				{ fields: ["target_type", "target_id"] },
				{ fields: ["created_at"] },
			],
		},
	);
}
